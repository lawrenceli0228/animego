// A bounded sweep that resolves `Series.anilistId` for series nobody has clicked.
//
// WHY THIS EXISTS
//
// Watch-progress sync hangs off `Series.anilistId`, and until now the only
// things that could create one were three user actions: clicking a card,
// opening `/library/[seriesId]`, and entering the player. `reconcileLibrary`
// deliberately did not resolve — `resolveSeriesBinding.ts` states the rule and
// the reason: resolving means a title search, and sweeping a mature library on
// mount would become hundreds of simultaneous searches for a page the reader
// only wanted to look at.
//
// The reason was right and the conclusion was wrong. Measured on a real
// 26-series library: 19 had no binding at all, and 18 of those 19 resolve
// through the EXISTING matcher at an exact-equality score. They were not hard
// to match. Nobody had ever asked.
//
// So the fix is not "resolve on mount" and not "never resolve" — it is
// "resolve on mount, bounded". This module is the bound.
//
// THE SHAPE IS COPIED, NOT INVENTED
//
// `episodeCountBackfill.ts` already runs a mount-triggered sweep over the same
// liveQuery and converges. Its three properties are the ones that matter and
// they are reproduced here:
//
//   · the candidate set is DERIVED from the rows, so a series that gets bound
//     drops out and the set shrinks monotonically toward empty;
//   · failures that are answers (searched, matched nothing) latch in a
//     module-level set so they are not re-asked for the rest of the session;
//   · failures that are NOT answers (network, rate limit) do not latch, because
//     a dropped request says nothing about the title.
//
// Without the second property this would loop forever: the sweep writes to
// `db.series`, `db.series` carries the liveQuery that re-fires the effect, and
// an unmatchable title would be re-searched on every emission for as long as
// the tab is open. The latch is what makes the loop terminate. It lives inside
// `resolveSeriesBinding` (`_unresolved`) and this module simply lets it work —
// which is also why this module must call `resolveSeriesBinding` rather than
// the search primitives underneath it.
//
// WHY THE MEMORY IS NOT PERSISTED
//
// Same argument `watchSync.ts` makes for its attempt counter and
// `episodeCountBackfill.ts` makes for its unknown-id set: the loop that had to
// die is the one inside a session. Across a reload we deliberately ask once
// more, because the answer can change — `anime_cache` backfills, and a title
// the search could not place last week is exactly the one that should resolve
// now. A persisted set would be a second source of truth for "is this series
// knowable", which is precisely the stale row those two modules refused.
//
// WHY THERE IS NO TRANSACTION AROUND THE WRITES
//
// Eighteen consecutive `db.series` writes would be eighteen liveQuery emissions
// and eighteen grid re-renders — a real concern, and one `animeBinding.ts`
// raises in its own doc comment. It does not apply here: the throttle below
// already spaces the writes hundreds of milliseconds apart, so they are never a
// burst in one tick. A Dexie transaction would also be actively wrong for this
// loop, because a transaction that awaits a non-Dexie promise aborts, and every
// iteration awaits a network round trip. Batching belongs on a path that writes
// without going to the network; this is not one.

import {
  resolveSeriesBinding,
  seriesSearchKeyword,
  type BindingResolverDb,
  type SeriesSearchFn,
} from "./resolveSeriesBinding";

/**
 * Series resolved per mount, at most.
 *
 * Sized so an ordinary library finishes in one visit while a very large one
 * still makes visible progress every time it is opened, rather than spending a
 * reader's whole session on background work. Progress is monotonic — bound
 * series leave the candidate set — so a library above the cap converges over
 * consecutive visits without any cursor to persist.
 */
export const BIND_SWEEP_CAP = 40;

/**
 * Gap between searches.
 *
 * `/api/dandanplay/search` is not in the rate limiter's public-read exemption,
 * so these searches draw on the same per-user bucket (1/s sustained, 60 burst)
 * as every other `/api/*` call the page makes — including the RSC fetches of
 * the render the reader is currently looking at. Sequential-with-a-gap keeps
 * the sweep a background hum instead of something that competes with the page.
 */
export const BIND_SWEEP_DELAY_MS = 350;

/** The `Series` fields this module reads. */
export interface SweepSeriesRow {
  readonly id?: string;
  readonly anilistId?: number | null;
  readonly titleZh?: string;
  readonly titleEn?: string;
  readonly titleJa?: string;
}

/**
 * The `opsLog` surface this module writes. Structural, like every sibling.
 *
 * `kind` is the literal `"rematch"` rather than the repo's full union on
 * purpose: this module writes one kind and only one, and declaring the wide
 * union here would let a future edit log a `delete` through a binding sweep
 * without the compiler objecting.
 */
export interface SweepOpsLog {
  append(entry: {
    seriesId: string;
    kind: "rematch";
    payload?: Record<string, unknown>;
    /**
     * Structured, not a sentence — `OpsLog.summary` is the data a toast or a
     * history row renders from, so the copy stays in the dictionary where it
     * can be translated rather than baked into a database row.
     */
    summary?: Record<string, unknown>;
  }): Promise<unknown>;
}

export interface SweepSummary {
  /** Eligible before the cap — how much work the library still holds. */
  readonly candidates: number;
  /** Actually searched this run. */
  readonly attempted: number;
  /** Wrote a new binding. */
  readonly bound: number;
  /** Searched and confidently matched nothing. Not asked again this session. */
  readonly unresolved: number;
  /** The request itself failed. Still eligible on the next run. */
  readonly failed: number;
  /** Left for the next mount, because of the cap. */
  readonly remaining: number;
  /** True when at least one binding landed — the caller's cue to re-reconcile. */
  readonly changed: boolean;
}

const EMPTY: SweepSummary = {
  candidates: 0,
  attempted: 0,
  bound: 0,
  unresolved: 0,
  failed: 0,
  remaining: 0,
  changed: false,
};

/**
 * The series worth searching for, in stable order, capped.
 *
 * Three filters, and the third is the one that is easy to miss:
 *
 *   1. already bound → nothing to do;
 *   2. no id → not a row we can write back to;
 *   3. NO USABLE TITLE → permanently unresolvable by this path, and it must be
 *      dropped HERE. `resolveSeriesBinding` returns early for an empty keyword
 *      without latching anything (correctly — it never asked, so it learned
 *      nothing), which means a titleless series would be re-picked on every
 *      single emission forever. Real libraries do hold these: a folder whose
 *      name parsed down to a fansub group leaves a row with no usable title.
 *
 * The caller passes ROOT rows only (`useLibrary`'s `series`, not `allSeries`).
 * A merged-in source renders on its root's card and syncs through its root, so
 * binding it independently would spend a search on an id nothing reads.
 */
export function collectUnboundSeries(
  series: readonly SweepSeriesRow[] | null | undefined,
  cap: number = BIND_SWEEP_CAP,
): SweepSeriesRow[] {
  const limit = Number.isInteger(cap) && cap > 0 ? cap : BIND_SWEEP_CAP;
  const out: SweepSeriesRow[] = [];
  for (const row of series ?? []) {
    if (!row || typeof row.id !== "string" || !row.id) continue;
    if (typeof row.anilistId === "number" && row.anilistId > 0) continue;
    if (!seriesSearchKeyword(row)) continue;
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

/** How many rows would qualify if there were no cap. Drives `remaining`. */
export function countUnboundSeries(
  series: readonly SweepSeriesRow[] | null | undefined,
): number {
  return collectUnboundSeries(series, Number.MAX_SAFE_INTEGER).length;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export interface SweepInput {
  readonly db: BindingResolverDb;
  /** Root series rows — `useLibrary`'s `series`, not `allSeries`. */
  readonly series: readonly SweepSeriesRow[] | null | undefined;
  /**
   * Written one row per binding, so an automatic decision is auditable after
   * the fact. Optional: a v4-shaped database has no `opsLog` table, and a
   * missing audit trail must not cost the user the binding.
   */
  readonly opsLog?: SweepOpsLog | null;
  /** Aborts between iterations — the reader navigated away. */
  readonly signal?: AbortSignal;
  /** Injected in tests; defaults to the real endpoint. */
  readonly search?: SeriesSearchFn;
  readonly cap?: number;
  readonly delayMs?: number;
}

/**
 * Resolve bindings for unbound series, bounded and throttled.
 *
 * NEVER THROWS. The caller is a fire-and-forget effect on a page that has
 * already rendered.
 *
 * Writes go through `resolveSeriesBinding` → `persistAutoBinding` →
 * `writeBinding`, so the automatic path physically cannot overwrite a binding
 * the user set by hand — that guarantee lives in `animeBinding.ts` and is not
 * re-implemented here.
 */
export async function bindUnboundSeries(
  input: SweepInput,
): Promise<SweepSummary> {
  const {
    db,
    series,
    opsLog = null,
    signal,
    search,
    cap = BIND_SWEEP_CAP,
    delayMs = BIND_SWEEP_DELAY_MS,
  } = input;
  if (!db?.series) return EMPTY;

  const candidates = countUnboundSeries(series);
  const batch = collectUnboundSeries(series, cap);
  if (batch.length === 0) {
    return { ...EMPTY, candidates, remaining: candidates };
  }

  let attempted = 0;
  let bound = 0;
  let unresolved = 0;
  let failed = 0;

  for (const row of batch) {
    if (signal?.aborted) break;
    if (attempted > 0 && delayMs > 0) {
      await sleep(delayMs);
      if (signal?.aborted) break;
    }
    attempted += 1;

    let result;
    try {
      result = await resolveSeriesBinding(db, row, search ? { search } : {});
    } catch (err) {
      // resolveSeriesBinding documents that it never throws, so reaching here
      // means something below it changed. Count it as a transient failure —
      // an unexpected throw is not evidence about this title — and carry on
      // rather than abandoning the rest of the sweep.
      failed += 1;
      console.warn(
        "[bindUnboundSeries] resolve threw:",
        err instanceof Error ? err.message : err,
      );
      continue;
    }

    if (result.outcome === "resolved" && result.anilistId) {
      bound += 1;
      await recordBinding(opsLog, row, result.anilistId);
      continue;
    }
    if (result.outcome === "none") {
      // Two different states share this outcome: "searched, matched nothing"
      // (latched inside resolveSeriesBinding, never asked again this session)
      // and "the search request failed" (deliberately not latched). Only the
      // service can tell them apart, and it does not report which — so this
      // count is honestly named `unresolved`, not `unmatched`, and the failed
      // ones simply stay eligible for the next run.
      unresolved += 1;
    }
  }

  return {
    candidates,
    attempted,
    bound,
    unresolved,
    failed,
    remaining: Math.max(0, candidates - bound),
    changed: bound > 0,
  };
}

/**
 * One `opsLog` row per automatic binding.
 *
 * This is the whole audit story for the sweep, and it is deliberately a log and
 * not an undo. `opsLog`'s kind allowlist has included `'rematch'` since v4 and
 * the 24h `undoableUntil` window is written for us — but the only undo actually
 * implemented is `undoMerge`, which throws on any other kind. Offering a button
 * that throws would be worse than offering none, so the payload records what
 * happened and the series detail page's recent-operations list surfaces it.
 *
 * Best effort. Failing to write the log must not cost the user the binding that
 * already landed.
 */
async function recordBinding(
  opsLog: SweepOpsLog | null,
  row: SweepSeriesRow,
  anilistId: number,
): Promise<void> {
  if (!opsLog || !row.id) return;
  try {
    await opsLog.append({
      seriesId: row.id,
      kind: "rematch",
      payload: {
        source: "auto-sweep",
        anilistId,
        keyword: seriesSearchKeyword(row),
      },
      summary: { anilistId, title: seriesSearchKeyword(row) },
    });
  } catch (err) {
    console.warn(
      "[bindUnboundSeries] ops log write failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

"use client";

// Ported from client/src/services/rematchSeries.js. Updates the primary
// season's dandanplay animeId, refreshes any series record fields the caller
// passes, and merges a userOverride row marking the choice as locked. All in a
// single rw transaction across series + seasons + userOverride.
//
// Two id spaces, split on purpose (they used to share one field and corrupt
// each other — see RematchDialog.normalize):
//
//   dandanAnimeId → Season.animeId. This module owns it. Danmaku and episode
//                   listings key off it; the import pipeline reuses seasons by
//                   matching it.
//   anilistId     → Series.anilistId. `animeBinding` owns it, and this module
//                   goes through that door like everyone else. A rematch is by
//                   definition a manual binding, so it is written with
//                   `source: 'manual'` and takes the lock.
//
// A picked hit may carry either id or both — `/api/dandanplay/search` returns
// animeCache rows (anilistId only) and dandanplay rows (dandanAnimeId only) —
// so both inputs are optional and at least one is required.
//
// Every rematch also leaves one `opsLog` row behind. Until now nothing did:
// `'rematch'` has been in the repo's kind allowlist since v4, but the only
// writers were merge and split, so the series detail page's recent-operations
// list had a hole exactly where the most consequential manual action is. The
// row is a log and NOT an undo — `undoMerge` is the only undo implemented and
// it throws on any other kind, so a button wired to it would be worse than no
// button. What the row buys is the answer to "why is this card pointing here"
// three months later, which is precisely the question two id spaces make hard.

import type Dexie from "dexie";
import { toPositiveInt } from "./animeIds";
import {
  writeBinding,
  type BindingDb,
  type BindingWriteReason,
} from "@/lib/library/animeBinding";
// The library/db helpers are JS modules — they get type-checked via JSDoc.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — JS module with JSDoc types
import { makeOpsLogRepo } from "@/lib/library/db/opsLogRepo.js";

interface SeasonRow {
  id: string;
  seriesId: string;
  number: number;
  animeId: number;
  totalEpisodes?: number;
  updatedAt?: number;
}

/**
 * The `opsLog` surface this module writes. Structural rather than the repo's
 * concrete type, like every sibling service (`BindingDb` in `animeBinding.ts`,
 * `SweepOpsLog` in `bindUnboundSeries.ts`), so a test can hand in a recorder
 * without an IndexedDB polyfill.
 *
 * `kind` is the literal `"rematch"` rather than the repo's full union on
 * purpose: this module writes one kind and only one, and declaring the wide
 * union here would let a future edit log a `delete` through a rematch without
 * the compiler objecting.
 */
export interface RematchOpsLog {
  append(entry: {
    seriesId: string;
    kind: "rematch";
    payload?: Record<string, unknown>;
    /**
     * Structured, not a sentence — `OpsLog.summary` is the data `OpsLogDrawer`
     * renders from, so the human copy stays in the dictionary where it can be
     * translated rather than baked into a database row.
     */
    summary?: Record<string, unknown>;
  }): Promise<unknown>;
}

/** The ids this rematch moved AWAY from, read before anything was written. */
interface PriorIds {
  readonly dandanAnimeId: number | null;
  readonly anilistId: number | null;
}

interface RematchSeriesInput {
  db: Dexie;
  seriesId: string;
  /** dandanplay id space. Omit when the picked hit has no dandanplay row. */
  dandanAnimeId?: number;
  /** AniList id space. Omit when the picked hit has no AniList row. */
  anilistId?: number;
  titleZh?: string;
  titleEn?: string;
  titleJa?: string;
  posterUrl?: string;
  /**
   * The picked hit's episode count. Written only when it is a positive
   * integer — `<= 0` is how every reader of `Series.totalEpisodes` spells
   * "unknown", so a zero would replace a real answer with a fake one.
   */
  totalEpisodes?: number;
  type?: "tv" | "movie" | "ova" | "web";
  /**
   * Where the audit row goes. Optional twice over: both call sites hand this
   * service a bare `db`, so the default is a repo built on that db, and a
   * handle whose schema predates the `opsLog` store (`db.js` adds it at v4)
   * gets no row at all. A missing audit trail must never cost the user the
   * rematch.
   */
  opsLog?: RematchOpsLog | null;
  ulid: () => string;
  now?: () => number;
}

function assertOptionalId(value: unknown, field: string): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`rematchSeries: ${field} must be a positive integer`);
  }
}

/**
 * Both id spaces use positive integers; anything else reads as "none".
 *
 * `null` rather than `undefined` because these values go into an ops-log
 * payload, where the two mean different things: `null` is "this space held
 * nothing", and an absent key is "we never looked at this space at all".
 * `toPositiveInt` owns the actual rule — this only adapts its convention.
 */
function positiveOrNull(value: unknown): number | null {
  return toPositiveInt(value) ?? null;
}

export async function rematchSeries(input: RematchSeriesInput): Promise<void> {
  const {
    db,
    seriesId,
    dandanAnimeId,
    anilistId,
    titleZh,
    titleEn,
    titleJa,
    posterUrl,
    totalEpisodes,
    type,
    opsLog,
    ulid,
    now = () => Date.now(),
  } = input;

  if (typeof seriesId !== "string" || !seriesId) {
    throw new Error("rematchSeries: seriesId must be a non-empty string");
  }
  assertOptionalId(dandanAnimeId, "dandanAnimeId");
  assertOptionalId(anilistId, "anilistId");
  if (dandanAnimeId === undefined && anilistId === undefined) {
    throw new Error(
      "rematchSeries: at least one of dandanAnimeId / anilistId is required",
    );
  }
  if (typeof ulid !== "function") {
    throw new Error("rematchSeries: ulid factory is required");
  }

  // What the audit row is a record OF: the ids in effect before this pick.
  // They are only readable inside the transaction below, before the updates
  // land, so they are captured there and used after it commits.
  let priorDandanAnimeId: number | null = null;
  let priorAnilistId: number | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tables = db as any;
  await tables.transaction(
    "rw",
    tables.series,
    tables.seasons,
    tables.userOverride,
    async () => {
      const series = await tables.series.get(seriesId);
      if (!series) {
        throw new Error(`rematchSeries: series ${seriesId} does not exist`);
      }

      const ts = now();
      priorAnilistId = positiveOrNull(series.anilistId);

      // Pick the primary (lowest-numbered) season; create one if absent.
      // Only when we actually have a dandanplay id — writing anything else here
      // is the bug this split exists to prevent.
      if (dandanAnimeId !== undefined) {
        const seasons = (await tables.seasons
          .where("seriesId")
          .equals(seriesId)
          .toArray()) as SeasonRow[];

        if (seasons.length === 0) {
          await tables.seasons.add({
            id: ulid(),
            seriesId,
            number: 1,
            animeId: dandanAnimeId,
            updatedAt: ts,
          });
        } else {
          const primary = seasons.reduce(
            (min, s) => (s.number < min.number ? s : min),
            seasons[0],
          );
          priorDandanAnimeId = positiveOrNull(primary.animeId);
          await tables.seasons.update(primary.id, {
            animeId: dandanAnimeId,
            updatedAt: ts,
          });
        }
      }

      const seriesPatch: Record<string, unknown> = { updatedAt: ts };
      if (titleZh !== undefined) seriesPatch.titleZh = titleZh;
      if (titleEn !== undefined) seriesPatch.titleEn = titleEn;
      if (titleJa !== undefined) seriesPatch.titleJa = titleJa;
      if (posterUrl !== undefined) seriesPatch.posterUrl = posterUrl;
      if (
        typeof totalEpisodes === "number" &&
        Number.isInteger(totalEpisodes) &&
        totalEpisodes > 0
      ) {
        seriesPatch.totalEpisodes = totalEpisodes;
      }
      if (type !== undefined) seriesPatch.type = type;
      await tables.series.update(seriesId, seriesPatch);

      const existingOverride = (await tables.userOverride.get(seriesId)) ?? {};
      await tables.userOverride.put({
        ...existingOverride,
        seriesId,
        locked: true,
        ...(dandanAnimeId !== undefined
          ? { overrideSeasonAnimeId: dandanAnimeId }
          : {}),
        updatedAt: ts,
      });
    },
  );

  // Outside the transaction on purpose: writeBinding opens its own reads and
  // writes, and nesting a second Dexie scope inside this one buys nothing here.
  // The lock is already committed above, so an auto match cannot slip in
  // between and claim the binding. If this throws, the season half stands and
  // the caller surfaces the error — a retry of the same rematch is idempotent.
  let bindingResult: BindingWriteReason | null = null;
  if (anilistId !== undefined) {
    const result = await writeBinding(
      db as unknown as BindingDb,
      seriesId,
      anilistId,
      "manual",
      now,
    );
    bindingResult = result.reason;
  }

  // Last, and only once both halves have landed: the row describes a rematch
  // that actually happened. A `writeBinding` throw above therefore leaves no
  // row, which is the honest outcome — the caller surfaces the error, and the
  // retry that follows is idempotent and logs then.
  await recordRematch({
    opsLog: resolveOpsLog(db, opsLog, now, ulid),
    seriesId,
    prior: { dandanAnimeId: priorDandanAnimeId, anilistId: priorAnilistId },
    dandanAnimeId,
    anilistId,
    bindingResult,
    title: titleZh ?? titleEn ?? titleJa,
  });
}

/**
 * The caller's log, or one built on `db`.
 *
 * Deriving is not a convenience. Both call sites (`LibraryShell`,
 * `LocalSeriesShell`) hand this service a bare `db`, so without a default there
 * would be no row in practice — and going through `makeOpsLogRepo` is what
 * keeps every writer of the table on one `id` / `ts` / `undoableUntil`
 * convention, which is the reason that repo exists at all. `null` when the
 * handle carries no `opsLog` table.
 */
function resolveOpsLog(
  db: Dexie,
  injected: RematchOpsLog | null | undefined,
  now: () => number,
  ulid: () => string,
): RematchOpsLog | null {
  if (injected) return injected;
  // A pre-v4 handle has no `opsLog` store, and `Dexie` types every table as
  // present, so the check has to go through the untyped view.
  const table = (db as unknown as { opsLog?: unknown } | null | undefined)
    ?.opsLog;
  if (!table) return null;
  // `makeId: ulid` rather than the repo's default: `OpsLog.id` is documented as
  // a ulid (`types.js`), and the caller already carries the factory.
  return makeOpsLogRepo(db, { now, makeId: ulid }) as unknown as RematchOpsLog;
}

/**
 * One `opsLog` row per rematch.
 *
 * BEST EFFORT. The rematch has already landed by the time this runs, so a log
 * write that fails must cost the user nothing — the same handling
 * `bindUnboundSeries.recordBinding` gives the sweep's rows.
 *
 * OUTSIDE THE TRANSACTION, necessarily: `opsLog` is not one of the three tables
 * that transaction was opened over, and Dexie throws on a table outside the
 * current scope. Widening the scope would put the audit row in the same commit
 * as the change it audits — tempting, until you notice it also means a failed
 * log write rolls back the rematch, which is the trade this function refuses.
 */
async function recordRematch(input: {
  opsLog: RematchOpsLog | null;
  seriesId: string;
  prior: PriorIds;
  dandanAnimeId?: number;
  anilistId?: number;
  bindingResult: BindingWriteReason | null;
  title?: string;
}): Promise<void> {
  const {
    opsLog,
    seriesId,
    prior,
    dandanAnimeId,
    anilistId,
    bindingResult,
    title,
  } = input;
  if (!opsLog) return;
  try {
    await opsLog.append({
      seriesId,
      kind: "rematch",
      payload: {
        // `bindUnboundSeries` writes rows of this same kind with
        // `source: 'auto-sweep'`. Without something to tell them apart, a row
        // saying "this card points at 12345" gives no way to know whether a
        // human chose that or a background sweep guessed it — and only one of
        // those is evidence of what the user wanted.
        source: "manual-pick",
        // The two id spaces, kept apart here for the same reason the schema
        // keeps them apart. A whole `null` — not `{ from: null }` — is how an
        // untouched space is spelled: a pick that carried no dandanplay id
        // never read the season row either, and "we did not look" must not be
        // written down as "there was nothing there".
        dandanplay:
          dandanAnimeId === undefined
            ? null
            : { from: prior.dandanAnimeId, to: dandanAnimeId },
        anilist:
          anilistId === undefined
            ? null
            : {
                from: prior.anilistId,
                to: anilistId,
                // Whether the AniList half actually moved, straight from
                // `writeBinding`. `to` alone cannot say: re-picking the id
                // already bound reports `unchanged`, and that is worth reading
                // back rather than re-deducing.
                result: bindingResult,
              },
        title: title ?? null,
      },
      summary: {
        // `targetTitle` is the key `OpsLogDrawer.summaryLineFor` reads for a
        // rematch row; with it the drawer renders the dictionary's
        // `summaryRematchTarget` line, without it the bare `summaryRematch`.
        ...(title ? { targetTitle: title } : {}),
        // The ids in effect after the pick, not the deltas — a history row
        // renders what the card points at now. `prior.anilistId` is always a
        // real read (the series row is fetched unconditionally), so the
        // fallback is the truth and not a guess; the dandanplay id is only
        // claimed when this pick actually set one.
        anilistId: anilistId ?? prior.anilistId,
        ...(dandanAnimeId !== undefined ? { dandanAnimeId } : {}),
      },
    });
  } catch (err) {
    console.warn(
      "[rematchSeries] ops log write failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

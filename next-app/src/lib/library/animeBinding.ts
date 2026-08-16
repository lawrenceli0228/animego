// The one door in and out of `Series.anilistId`.
//
// Why a module for two field writes: there are three writers (title-search
// auto-match, the rematch dialog, and — once the reconciler lands — the sync
// path itself) and two readers. Decision 11 of the plan calls it: three writers
// and two readers with no chokepoint will drift. The specific drift that costs
// users data is auto-match quietly stomping a binding the user set by hand.
//
// The precedent is Taiga (`anime_util.cpp:220-241`): a manual link is written
// as a user synonym that ranks AHEAD of the official titles from then on. Same
// rule here, expressed as a lock rather than a ranking: `source: 'auto'` may
// never overwrite a binding the user owns.
//
// Two ids, two spaces — do not mix them:
//   Series.anilistId  → AniList. Subscriptions, watch progress, the site's own
//                       /anime/{id} pages.
//   Season.animeId    → dandanplay. Danmaku and episode listings. Owned by
//                       rematchSeries, not by this module.
//
// No Dexie import at module scope and no `db` singleton import: the db module
// throws when it is loaded outside a browser, and the decision logic below has
// to stay reachable from a plain Node test.
//
// Known, accepted race: read-decide-write is not wrapped in a transaction, so
// two tabs resolving the same series in the same instant can have an auto write
// land after a manual one. Recoverable (re-pick), not silent data loss, and the
// alternative is threading Dexie's transaction signature through a structural
// interface that exists specifically so tests can fake it.

/** Who set a binding. Manual outranks auto, always. */
export type BindingSource = "auto" | "manual";

export interface AnimeBinding {
  anilistId: number;
  source: BindingSource;
}

/** Why `writeBinding` did (or did not) write. Never silently swallowed. */
export type BindingWriteReason =
  | "written"
  | "locked"
  | "unchanged"
  | "invalid-id"
  | "missing-series";

export interface BindingWriteResult {
  written: boolean;
  reason: BindingWriteReason;
  /** The id now in effect — the newly written one, or the one that won. */
  anilistId: number | null;
}

/** The subset of a Series row this module reads. */
export interface BindableSeries {
  anilistId?: number | null;
}

/** The subset of a UserOverride row this module reads. */
export interface BindingOverride {
  locked?: boolean;
}

export interface BindingDecision {
  /** Write `series.anilistId`. */
  writeSeries: boolean;
  /** Set `userOverride.locked = true` (manual writes only). */
  lock: boolean;
  reason: BindingWriteReason;
  anilistId: number | null;
}

/** Narrow unknown input to a usable AniList id. AniList ids are positive ints. */
function toAnilistId(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Is this series' binding user-owned?
 *
 * `locked` already exists on UserOverride (`types.js`) and already means "the
 * user decided this one — do not re-match it automatically on next import".
 * Both writers of it are manual actions: the rematch dialog and the card's lock
 * menu item. That is exactly the predicate this module needs, so it reuses the
 * flag rather than inventing a second, competing notion of ownership that would
 * immediately need reconciling with the first.
 */
export function isBindingLocked(
  override: BindingOverride | null | undefined,
): boolean {
  return override?.locked === true;
}

/**
 * The whole policy, as one pure function. Everything below it is plumbing.
 *
 * Rules, in order:
 *   1. A non-positive / non-integer id is never written.
 *   2. `auto` never overwrites a locked binding — it reports `locked` and the
 *      manual id stays in effect. It does not throw and it does not pretend to
 *      have succeeded; callers get a result they can log or surface.
 *   3. Writing the id that is already there is skipped. Not just an
 *      optimization: `db.series` carries a liveQuery, and re-match runs on
 *      every session, so a write-every-time policy would churn IDB and
 *      re-render the grid for nothing.
 *   4. `manual` always writes and always locks. A re-pick of the same id still
 *      takes the lock if the row was not locked yet.
 */
export function decideBindingWrite(input: {
  series: BindableSeries | null | undefined;
  override: BindingOverride | null | undefined;
  nextAnilistId: unknown;
  source: BindingSource;
}): BindingDecision {
  const { series, override, source } = input;
  const nextId = toAnilistId(input.nextAnilistId);

  if (nextId === null) {
    return {
      writeSeries: false,
      lock: false,
      reason: "invalid-id",
      anilistId: toAnilistId(series?.anilistId),
    };
  }
  if (!series) {
    return {
      writeSeries: false,
      lock: false,
      reason: "missing-series",
      anilistId: null,
    };
  }

  const currentId = toAnilistId(series.anilistId);
  const locked = isBindingLocked(override);

  if (source === "auto" && locked) {
    // The user's pick wins. Report the id that stays in effect, not the one we
    // refused — the caller usually wants to render something.
    return {
      writeSeries: false,
      lock: false,
      reason: "locked",
      anilistId: currentId,
    };
  }

  const needsLock = source === "manual" && !locked;
  if (currentId === nextId && !needsLock) {
    return {
      writeSeries: false,
      lock: false,
      reason: "unchanged",
      anilistId: currentId,
    };
  }

  return {
    writeSeries: currentId !== nextId,
    lock: needsLock,
    reason: "written",
    anilistId: nextId,
  };
}

// ─── Cache invalidation ─────────────────────────────────────────────────────

type BindingListener = (seriesId: string) => void;

const _listeners = new Set<BindingListener>();

/**
 * Subscribe to binding changes so module-level caches elsewhere can drop their
 * entry. Callers keep their own caches (the site-anime hook caches whole
 * metadata objects, which is none of this module's business) but they do not
 * get to decide *when* those go stale — that is what drifts.
 *
 * Returns an unsubscribe function.
 */
export function onBindingChanged(listener: BindingListener): () => void {
  _listeners.add(listener);
  return () => {
    _listeners.delete(listener);
  };
}

function emitBindingChanged(seriesId: string): void {
  for (const listener of [..._listeners]) {
    try {
      listener(seriesId);
    } catch {
      // A broken cache invalidator must not fail the write that already landed.
    }
  }
}

// ─── Dexie-backed entry points ──────────────────────────────────────────────

/**
 * Minimal shape of the tables this module touches. Structural rather than
 * `Dexie` so tests can hand in a fake without an IndexedDB polyfill, and so a
 * v5 database (no `userOverride`) degrades instead of throwing.
 */
export interface BindingDb {
  series: {
    get(id: string): Promise<BindableSeries | undefined>;
    update(id: string, changes: Record<string, unknown>): Promise<unknown>;
  };
  userOverride?: {
    get(id: string): Promise<BindingOverride | undefined>;
    put(row: Record<string, unknown>): Promise<unknown>;
  } | null;
}

/**
 * The current binding for a series, or null when there is none.
 *
 * `source` is derived, not stored: a locked override means the user owns this
 * binding. Storing a second copy of that fact is how the two get to disagree.
 */
export async function readBinding(
  db: BindingDb,
  seriesId: string,
): Promise<AnimeBinding | null> {
  if (!seriesId) return null;
  const series = await db.series.get(seriesId);
  const anilistId = toAnilistId(series?.anilistId);
  if (anilistId === null) return null;

  const override = db.userOverride
    ? await db.userOverride.get(seriesId)
    : null;
  return {
    anilistId,
    source: isBindingLocked(override) ? "manual" : "auto",
  };
}

/**
 * Write a binding. The only supported way to set `Series.anilistId`.
 *
 * `source: 'auto'` is refused on a locked series — refused loudly, via the
 * returned reason, never by throwing and never by pretending. `source:
 * 'manual'` always wins and takes the lock, so the next auto pass cannot undo
 * what the user just did.
 *
 * Deliberately does NOT bump `series.updatedAt`: the library grid's "new
 * additions" row sorts on it, and resolving an id is not the user adding
 * anything.
 */
export async function writeBinding(
  db: BindingDb,
  seriesId: string,
  anilistId: unknown,
  source: BindingSource,
  now: () => number = () => Date.now(),
): Promise<BindingWriteResult> {
  if (!seriesId) {
    return { written: false, reason: "missing-series", anilistId: null };
  }

  const series = await db.series.get(seriesId);
  const override = db.userOverride
    ? await db.userOverride.get(seriesId)
    : null;

  const decision = decideBindingWrite({
    series,
    override,
    nextAnilistId: anilistId,
    source,
  });

  // A v5-shaped database has no `userOverride` table, so a lock cannot be
  // recorded there. Report what actually happened rather than a write that did
  // not.
  const willLock = decision.lock && Boolean(db.userOverride);
  if (!decision.writeSeries && !willLock) {
    return {
      written: false,
      reason: decision.reason === "written" ? "unchanged" : decision.reason,
      anilistId: decision.anilistId,
    };
  }

  if (decision.writeSeries) {
    await db.series.update(seriesId, { anilistId: decision.anilistId });
  }
  if (willLock && db.userOverride) {
    await db.userOverride.put({
      ...(override ?? {}),
      seriesId,
      locked: true,
      updatedAt: now(),
    });
  }

  emitBindingChanged(seriesId);
  return {
    written: true,
    reason: decision.reason,
    anilistId: decision.anilistId,
  };
}

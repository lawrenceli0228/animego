// The two numbers a (possibly merged) series card shows: how many episodes it
// is supposed to have, and how many of those the user has actually watched.
//
// Both have to be computed across the merge group, and for the same reason —
// `performMerge` is a SOFT merge. It never moves a Season row, never moves an
// Episode row and never moves a Progress row; it only appends the source id to
// the target's `mergedFrom`. Anything that reads one series row and stops has
// already lost half the card. `loadSeriesRows.ts` is the same rule applied to
// episodes; this module is that rule applied to the totals.
//
// ─── why a merged card must NOT simply sum its members ──────────────────────
//
// There are two kinds of merge and they want opposite arithmetic:
//
//   dedupeSeriesByAnimeId  merges rows that SHARE a `Season.animeId` — the same
//                          season imported twice. Summing two 12-episode
//                          members would claim 24.
//   MergeDialog            merges whatever the user picked, which is usually
//                          two genuinely different seasons. Here summing is the
//                          right answer.
//
// `mergedFrom` records that a merge happened, never which kind. The
// discriminator that survives is `Season.animeId`, WHEN A MEMBER ACTUALLY HAS
// ONE: dandanplay issues one per season, and because the merge is soft every
// member keeps its own Season rows. So the group's members are folded by their
// season identity first, and only the distinct identities are summed.
//
// The qualifier is load-bearing, not a hedge. The automatic import path obtains
// no dandanplay id at all — `/api/dandanplay/match` returns none in any phase,
// so `applyEnrichment` writes no Season row rather than a fabricated one — which
// leaves a manual rematch as the only reliable source of a season identity.
// `primaryAnimeIdBySeries` below already reads that absence as "cannot identify
// this member", which is why the size-1 exception described next is doing real
// work rather than covering an edge case.
//
// ─── the safe direction is DOWN ─────────────────────────────────────────────
//
// A member we cannot identify (no Season row, or a Season with no `animeId`)
// is therefore treated as a duplicate of something already counted, not as a
// new season. That under-counts. Under-counting shows a progress bar that
// reads fuller than it should; over-counting is the direction that starts
// hiding episodes the user has on disk (issue #75), so when in doubt this
// module counts less rather than more.
//
// The one exception is a group of exactly one member, where there is provably
// nothing to be a duplicate OF. Without it a never-merged series that has no
// Season row — an import whose dandanplay match failed — would keep reporting
// "unknown" even after its total was resolved, which is the whole bug this
// change exists to fix.

import { resolveMergedSeriesIds } from "./resolveMergedIds";

/** The `Series` fields this module reads. See `lib/library/types.js`. */
export interface GroupSeriesRow {
  readonly id: string;
  readonly totalEpisodes?: number | null;
}

/** The `Season` fields this module reads. */
export interface GroupSeasonRow {
  readonly seriesId?: string;
  /** S1 / S2 — used only to pick a member's primary season deterministically. */
  readonly number?: number;
  /**
   * dandanplay's per-season id — the identity this module folds on, for the
   * members that have one. Frequently they do not: the automatic import path
   * resolves no dandanplay id, so a series nobody has rematched carries no
   * season identity and `primaryAnimeIdBySeries` simply leaves it out.
   */
  readonly animeId?: number | null;
}

/** The `UserOverride` fields this module reads. */
export interface GroupOverrideRow {
  readonly seriesId?: string;
  readonly mergedFrom?: string[];
}

/** One entry of `useSeriesProgressMap`'s map. */
export interface GroupProgressInfo {
  readonly watchedCount: number;
  readonly completedCount: number;
  readonly lastPlayedAt: number;
}

/**
 * Overrides arrive as an array from Dexie and as a Map from `useUserOverride`.
 * Both are accepted so no caller has to build a throwaway copy on every render.
 */
export type GroupOverrideInput =
  | readonly GroupOverrideRow[]
  | ReadonlyMap<string, GroupOverrideRow>
  | null
  | undefined;

function overrideRows(input: GroupOverrideInput): readonly GroupOverrideRow[] {
  if (!input) return [];
  return input instanceof Map ? [...input.values()] : (input as readonly GroupOverrideRow[]);
}

/**
 * Positive integer or nothing. `<= 0` means "unknown" everywhere downstream.
 *
 * Exported so `episodeGridModel.ts` can spell "is this total usable" the same
 * way rather than keeping a second copy of the rule that could drift from it.
 */
export function positiveTotal(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/**
 * Each series' primary `Season.animeId` — the lowest-numbered season's, the
 * same "primary" `rematchSeries` writes to.
 *
 * A series with no Season row, or whose seasons carry no usable `animeId`, is
 * simply absent: callers read that as "cannot identify this member".
 */
function primaryAnimeIdBySeries(
  seasons: readonly GroupSeasonRow[] | null | undefined,
): Map<string, number> {
  const best = new Map<string, { number: number; animeId: number }>();
  for (const season of seasons ?? []) {
    const seriesId = season?.seriesId;
    if (typeof seriesId !== "string" || !seriesId) continue;
    const animeId = season.animeId;
    if (typeof animeId !== "number" || !Number.isInteger(animeId) || animeId <= 0) {
      continue;
    }
    // `number` is optional in practice (older rows); treat a missing one as S1
    // so it still competes rather than sorting last by accident.
    const number = typeof season.number === "number" ? season.number : 1;
    const current = best.get(seriesId);
    if (
      !current ||
      number < current.number ||
      // Deterministic tie-break so two seasons sharing a number cannot make the
      // whole grid depend on Dexie's row order.
      (number === current.number && animeId < current.animeId)
    ) {
      best.set(seriesId, { number, animeId });
    }
  }

  const out = new Map<string, number>();
  for (const [seriesId, v] of best) out.set(seriesId, v.animeId);
  return out;
}

/**
 * Total episodes per merge-group root.
 *
 * Pass EVERY `Series` row, including the ones `useLibrary` hides for being
 * merged into something else: a merged-in source's own `totalEpisodes` is
 * precisely the number this has to read, and it is not in the visible list.
 *
 * Absent from the returned map means "unknown". Zero is never stored — every
 * reader already treats `<= 0` as unknown, so an explicit 0 would only be a
 * second way of spelling the same thing.
 *
 * @param series every Series row (visible and merged-away alike)
 * @param seasons every Season row
 * @param overrides every UserOverride row, or the Map keyed by seriesId
 */
export function buildGroupTotals(
  series: readonly GroupSeriesRow[] | null | undefined,
  seasons: readonly GroupSeasonRow[] | null | undefined,
  overrides: GroupOverrideInput,
): Map<string, number> {
  const out = new Map<string, number>();
  const rows = series ?? [];
  if (rows.length === 0) return out;

  const overrideList = overrideRows(overrides);
  const totalBySeries = new Map<string, number>();
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || !row.id) continue;
    const total = positiveTotal(row.totalEpisodes);
    if (total !== undefined) totalBySeries.set(row.id, total);
  }
  const animeIdBySeries = primaryAnimeIdBySeries(seasons);

  for (const row of rows) {
    if (!row || typeof row.id !== "string" || !row.id) continue;

    // Root first, transitive, cycle-guarded — see resolveMergedIds.ts.
    const members = resolveMergedSeriesIds(overrideList, row.id);

    if (members.length <= 1) {
      // Nothing was merged in, so there is nothing this member could be a
      // duplicate of and the season identity is irrelevant.
      const solo = totalBySeries.get(row.id);
      if (solo !== undefined) out.set(row.id, solo);
      continue;
    }

    // One slot per distinct season identity. The first member that fills a slot
    // wins, and members are in root-first order, so the card's own value beats a
    // merged-in source's when both describe the same season. A member whose slot
    // is claimed, or that has no identity at all, contributes nothing.
    const byAnimeId = new Map<number, number>();
    for (const memberId of members) {
      const animeId = animeIdBySeries.get(memberId);
      if (animeId === undefined) continue;
      if (byAnimeId.has(animeId)) continue;
      const total = totalBySeries.get(memberId);
      // Leave the slot open: a later member sharing this animeId may know the
      // number this one does not.
      if (total === undefined) continue;
      byAnimeId.set(animeId, total);
    }

    let sum = 0;
    for (const total of byAnimeId.values()) sum += total;
    if (sum > 0) out.set(row.id, sum);
  }

  return out;
}

/**
 * Episodes across a set of CARDS — the HUD's "N episodes" counter.
 *
 * Pass the visible rows, never `allSeries`: a merged-in source has no card of
 * its own and its episodes are already inside its root's group total, so
 * including it would count them twice.
 */
export function sumGroupTotals(
  series: readonly GroupSeriesRow[] | null | undefined,
  groupTotals: ReadonlyMap<string, number> | null | undefined,
): number {
  if (!groupTotals) return 0;
  let sum = 0;
  for (const row of series ?? []) {
    if (!row?.id) continue;
    sum += groupTotals.get(row.id) ?? 0;
  }
  return sum;
}

/** The `Episode` fields the grid-length rule reads. */
export interface GroupEpisodeRow {
  readonly number?: number;
}

/**
 * How many episode chips the detail sheet must render when nothing declares a
 * total — `buildGridCells`' fallback, and its only caller.
 *
 * ─── MANDATORY REGRESSION R1 ────────────────────────────────────────────────
 *
 * A grid length is not a label: for as long as the sheet rendered
 * `Array.from({ length: n })` and looked each number up in a map, this value
 * was the only thing deciding whether a file the user has on disk was
 * reachable in the UI at all. Issue #75 was that bug arriving from the query
 * side (a merged card read only the root's episodes); trusting a declared
 * total as a ceiling would re-create it from the arithmetic side, on the very
 * same cards.
 *
 * `declared` is therefore a floor, never a ceiling here. It legitimately comes
 * in BELOW what is indexed:
 *
 *   - a card holding specials or an OVA numbered past the season's length
 *   - a merge whose member could not be identified by `Season.animeId`, which
 *     `buildGroupTotals` deliberately under-counts
 *   - a season-length total on a card that was merged with a second cour
 *
 * `buildGridCells` now keeps that guarantee a different way — every episode
 * that wins no slot goes to a visible unclassified lane — which is why it
 * passes `declared` as `undefined` and uses this purely as "how long is a grid
 * with nothing to size it but the files themselves". The floor behaviour is
 * left intact rather than simplified away: it is the fallback's ceiling too,
 * and weakening it is exactly how R1 comes back.
 *
 * The `1` keeps a card with nothing indexed and no total from collapsing to an
 * empty grid.
 */
export function resolveEpisodeGridLength(
  declared: number | null | undefined,
  episodes: readonly GroupEpisodeRow[] | null | undefined,
): number {
  const rows = episodes ?? [];
  const floor = positiveTotal(declared) ?? 0;
  let maxNumber = 0;
  for (const ep of rows) {
    const n = ep?.number;
    if (typeof n === "number" && Number.isFinite(n) && n > maxNumber) maxNumber = n;
  }
  return Math.max(floor, Math.floor(maxNumber), rows.length, 1);
}

/**
 * Watch progress per merge-group root.
 *
 * The denominator without this is worse than no change at all: `buildGroupTotals`
 * widens a merged card's total to cover every season on it while
 * `useSeriesProgressMap` still folds by bare `seriesId`, so the card would
 * divide the root's own watched count by everybody's episodes and read as less
 * watched than it did before. The two have to move together.
 *
 * Counts add (a progress row belongs to exactly one series, so no member can be
 * double-counted); `lastPlayedAt` takes the newest across the group, because
 * "when did I last touch this card" is a max, not a sum.
 *
 * A root with no progress anywhere in its group gets no entry — same contract
 * as the map coming in, where absent means "never played".
 */
export function foldGroupProgress(
  progressMap: ReadonlyMap<string, GroupProgressInfo> | null | undefined,
  series: readonly GroupSeriesRow[] | null | undefined,
  overrides: GroupOverrideInput,
): Map<string, GroupProgressInfo> {
  const out = new Map<string, GroupProgressInfo>();
  const rows = series ?? [];
  if (!progressMap || rows.length === 0) return out;

  const overrideList = overrideRows(overrides);

  for (const row of rows) {
    if (!row || typeof row.id !== "string" || !row.id) continue;
    const members = resolveMergedSeriesIds(overrideList, row.id);

    let watchedCount = 0;
    let completedCount = 0;
    let lastPlayedAt = 0;
    let found = false;
    for (const memberId of members) {
      const info = progressMap.get(memberId);
      if (!info) continue;
      found = true;
      watchedCount += info.watchedCount ?? 0;
      completedCount += info.completedCount ?? 0;
      if ((info.lastPlayedAt ?? 0) > lastPlayedAt) lastPlayedAt = info.lastPlayedAt ?? 0;
    }
    if (found) out.set(row.id, { watchedCount, completedCount, lastPlayedAt });
  }

  return out;
}

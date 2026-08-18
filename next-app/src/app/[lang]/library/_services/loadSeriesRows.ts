// Load every episode + progress row that belongs on one (possibly merged)
// series card.
//
// Extracted out of SeriesDetailSheet's effect so the part that was actually
// broken is testable. The bug was one word: the sheet queried
// `.where("seriesId").equals(series.id)`, which reads the target's own rows
// and nothing else. performMerge is a SOFT merge — it never moves an episode
// row, it only appends the source id to the target's `mergedFrom` — so after
// any merge the card silently dropped every episode that came from the source.
// On the very card the merge was performed to build.
//
// The `progress` half is the quiet one: get it wrong and the episodes appear
// but come back marked unwatched, which looks like lost history rather than a
// query bug.
//
// A pure resolver alone could not have caught this. resolveMergedSeriesIds was
// always correct; nothing called it here. So the test that matters is not "do
// we compute the right ids" but "do we hand those ids to the query" — which is
// why this returns `seriesIds` alongside the rows, and why the fake db in the
// test records which Dexie method the caller reached for.

import { resolveMergedSeriesIds } from "./resolveMergedIds";

interface RowQuery<T> {
  where(index: string): {
    anyOf(values: readonly string[]): { toArray(): Promise<T[]> };
  };
}

interface OverrideTable {
  toArray(): Promise<{ seriesId?: string; mergedFrom?: string[] }[]>;
}

export interface SeriesRowsDb<E, P> {
  episodes: RowQuery<E>;
  progress: RowQuery<P>;
  /** Absent on older databases — treated as "nothing was ever merged". */
  userOverride?: OverrideTable | null;
}

export interface SeriesRowsResult<E, P> {
  /** Every contributing series id, root first. Returned for assertions/logging. */
  seriesIds: string[];
  /**
   * The card's own series id — the one the caller asked for, and the only one
   * that owns a binding.
   *
   * A merged card draws episodes from several series rows, but only one of them
   * can carry `anilistId` / `lastSyncedEpisode` (v6): the root. Anything
   * computing a watch high-water mark across this card therefore aggregates
   * over `episodes` + `progress` (all contributors) but syncs against the root.
   * Split those two and you get progress from a merged-in source pushed to
   * whatever the source happened to be bound to — a different show.
   *
   * It is `seriesIds[0]` by construction; named here so callers stop having to
   * know that, and empty only when `seriesId` was.
   */
  rootSeriesId: string;
  episodes: E[];
  progress: P[];
}

export async function loadMergedSeriesRows<E, P>(
  db: SeriesRowsDb<E, P>,
  seriesId: string,
): Promise<SeriesRowsResult<E, P>> {
  if (!seriesId) {
    return { seriesIds: [], rootSeriesId: "", episodes: [], progress: [] };
  }

  const overrides = db.userOverride ? await db.userOverride.toArray() : [];
  const seriesIds = resolveMergedSeriesIds(overrides, seriesId);

  // anyOf, never equals — see the header. Both tables, always the same id set:
  // querying progress with a narrower set is the failure mode that looks like
  // deleted watch history.
  const [episodes, progress] = await Promise.all([
    db.episodes.where("seriesId").anyOf(seriesIds).toArray(),
    db.progress.where("seriesId").anyOf(seriesIds).toArray(),
  ]);

  return { seriesIds, rootSeriesId: seriesId, episodes, progress };
}

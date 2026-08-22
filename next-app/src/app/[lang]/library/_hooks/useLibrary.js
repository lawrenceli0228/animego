// @ts-nocheck
"use client";
import { useSyncExternalStore, useCallback, useState, useRef } from 'react';
import { liveQuery } from 'dexie';

/** @typedef {import('@/lib/library/types').Series} Series */
/** @typedef {import('@/lib/library/types').Season} Season */

/**
 * @typedef {Object} LibrarySnapshot
 * @property {Series[]} series    - grid-visible rows (merged-in sources removed)
 * @property {Series[]} allSeries - every row, merged-in sources included
 * @property {Season[]} seasons   - every season row
 */

/** Stable identity — `useSyncExternalStore` re-renders forever on a fresh one. */
const EMPTY_SNAPSHOT = /** @type {LibrarySnapshot} */ ({
  series: [],
  allSeries: [],
  seasons: [],
});

/**
 * React hook that subscribes to the series table via Dexie liveQuery.
 *
 * Hides any series whose id appears in some other series' userOverride
 * `mergedFrom` array. `performMerge` is soft (it never deletes the source
 * row, so undo can restore the prior override snapshot in one write); the
 * filter here is what makes the merged source disappear from the grid.
 *
 * `allSeries` and `seasons` ride along on the SAME liveQuery rather than
 * getting subscriptions of their own. Both exist for `buildGroupTotals`:
 *
 *   allSeries — a merged card's total is assembled from its members' own
 *               `totalEpisodes`, and every member is by definition one of the
 *               rows `series` filters out. Computing group totals from the
 *               visible list alone can only ever see the root's own number.
 *   seasons   — `Season.animeId` is the only thing that distinguishes "the same
 *               season recorded twice" (auto-dedupe, must not sum) from "two
 *               different seasons" (manual merge, must sum).
 *
 * @param {{ db: import('dexie').Dexie }} options
 * @returns {{
 *   series: Series[],
 *   allSeries: Series[],
 *   seasons: Season[],
 *   loading: boolean,
 *   refetch(): void,
 * }}
 */
function useLibrary({ db }) {
  const [rev, setRev] = useState(0);

  /** @type {React.MutableRefObject<LibrarySnapshot | null>} */
  const snapshotRef = useRef(null);
  /** Track which (db, rev) the current snapshot belongs to so we don't serve stale data after refetch. */
  const snapshotKeyRef = useRef(/** @type {{ db: any, rev: number } | null} */(null));

  const subscribe = useCallback(
    (onChange) => {
      // Reset on (re)subscribe so a fresh liveQuery yields a fresh snapshot.
      snapshotRef.current = null;
      snapshotKeyRef.current = { db, rev };

      const sub = liveQuery(async () => {
        const [allSeries, overrides, seasons] = await Promise.all([
          db.series.orderBy('updatedAt').reverse().toArray(),
          db.userOverride ? db.userOverride.toArray() : Promise.resolve([]),
          db.seasons ? db.seasons.toArray() : Promise.resolve([]),
        ]);
        const merged = new Set();
        for (const o of overrides) {
          if (Array.isArray(o?.mergedFrom)) {
            for (const id of o.mergedFrom) merged.add(id);
          }
        }
        const series = merged.size === 0
          ? allSeries
          : allSeries.filter((s) => !merged.has(s.id));
        return { series, allSeries, seasons };
      }).subscribe({
        next: (v) => {
          snapshotRef.current = /** @type {LibrarySnapshot} */ (v);
          onChange();
        },
        error: () => {
          snapshotRef.current = EMPTY_SNAPSHOT;
          onChange();
        },
      });

      return () => {
        sub.unsubscribe();
      };
    },
    [db, rev],
  );

  const getSnapshot = useCallback(() => {
    const key = snapshotKeyRef.current;
    if (!key || key.db !== db || key.rev !== rev) return null;
    return snapshotRef.current;
  }, [db, rev]);

  const getServerSnapshot = useCallback(() => EMPTY_SNAPSHOT, []);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const loading = snapshot === null;
  const resolved = snapshot ?? EMPTY_SNAPSHOT;

  const refetch = useCallback(() => {
    setRev((r) => r + 1);
  }, []);

  return {
    series: resolved.series,
    allSeries: resolved.allSeries,
    seasons: resolved.seasons,
    loading,
    refetch,
  };
}

export { useLibrary };
export default useLibrary;

// @ts-nocheck
"use client";
import { useSyncExternalStore, useCallback, useRef, useMemo } from 'react';
import { liveQuery } from 'dexie';

/**
 * @typedef {Object} SeriesProgressInfo
 * @property {number} watchedCount   - distinct episodes with progress (touched)
 * @property {number} completedCount - episodes with completed=true
 * @property {number} lastPlayedAt   - latest updatedAt across all progress for this series
 */

/**
 * @typedef {Object} SeriesProgressSnapshot
 * @property {Map<string, SeriesProgressInfo>} map
 * @property {import('@/lib/library/types').Progress[]} rows - the raw rows the map was built from
 */

/**
 * Aggregate progress per series. Returns a Map keyed by seriesId.
 *
 * Reactive via dexie.liveQuery — the map is recomputed whenever any progress
 * record changes. Used by LibraryPage filter chips and SeriesGrid card progress.
 *
 * `rows` is the same `db.progress.toArray()` result the map is folded from,
 * handed out instead of dropped. The watch-progress reconciler needs the raw
 * rows (which episode, completed or not) and the aggregate throws exactly that
 * away; re-reading the table for it would be a second full scan of the thing
 * this query just scanned. Keeping the array alive costs one reference.
 *
 * @param {{ db: import('dexie').Dexie }} options
 * @returns {{
 *   map: Map<string, SeriesProgressInfo>,
 *   rows: import('@/lib/library/types').Progress[],
 *   loading: boolean,
 * }}
 */
function useSeriesProgressMap({ db }) {
  /** @type {React.MutableRefObject<SeriesProgressSnapshot|null>} */
  const snapshotRef = useRef(null);
  const dbRef = useRef(/** @type {any} */ (null));

  const subscribe = useCallback(
    (onChange) => {
      snapshotRef.current = null;
      dbRef.current = db;

      const sub = liveQuery(async () => {
        const all = await db.progress.toArray();
        /** @type {Map<string, SeriesProgressInfo>} */
        const map = new Map();
        for (const p of all) {
          if (!p || typeof p.seriesId !== 'string' || !p.seriesId) continue;
          const cur = map.get(p.seriesId) ?? {
            watchedCount: 0,
            completedCount: 0,
            lastPlayedAt: 0,
          };
          cur.watchedCount += 1;
          if (p.completed) cur.completedCount += 1;
          if (typeof p.updatedAt === 'number' && p.updatedAt > cur.lastPlayedAt) {
            cur.lastPlayedAt = p.updatedAt;
          }
          map.set(p.seriesId, cur);
        }
        return { map, rows: all };
      }).subscribe({
        next: (v) => {
          snapshotRef.current = v;
          onChange();
        },
        error: () => {
          snapshotRef.current = { map: new Map(), rows: [] };
          onChange();
        },
      });

      return () => sub.unsubscribe();
    },
    [db],
  );

  const getSnapshot = useCallback(() => {
    if (dbRef.current !== db) return null;
    return snapshotRef.current;
  }, [db]);

  const getServerSnapshot = useCallback(
    () => /** @type {SeriesProgressSnapshot|null} */ (null),
    [],
  );

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  return useMemo(
    () => ({
      map: snapshot?.map ?? /** @type {Map<string, SeriesProgressInfo>} */ (new Map()),
      rows: snapshot?.rows ?? [],
      loading: snapshot === null,
    }),
    [snapshot],
  );
}

export { useSeriesProgressMap };
export default useSeriesProgressMap;

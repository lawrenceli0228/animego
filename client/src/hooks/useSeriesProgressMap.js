// @ts-check
import { useSyncExternalStore, useCallback, useRef, useMemo } from 'react';
import { liveQuery } from 'dexie';

/**
 * @typedef {Object} SeriesProgressInfo
 * @property {number} watchedCount   - distinct episodes with progress (touched)
 * @property {number} completedCount - episodes with completed=true
 * @property {number} lastPlayedAt   - latest updatedAt across all progress for this series
 */

/**
 * Aggregate progress per series. Returns a Map keyed by seriesId.
 *
 * Reactive via dexie.liveQuery — the map is recomputed whenever any progress
 * record changes. Used by LibraryPage filter chips and SeriesGrid card progress.
 *
 * @param {{ db: import('dexie').Dexie }} options
 * @returns {{ map: Map<string, SeriesProgressInfo>, loading: boolean }}
 */
export default function useSeriesProgressMap({ db }) {
  /** @type {React.MutableRefObject<Map<string, SeriesProgressInfo>|null>} */
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
        return map;
      }).subscribe({
        next: (v) => {
          snapshotRef.current = v;
          onChange();
        },
        error: () => {
          snapshotRef.current = new Map();
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
    () => /** @type {Map<string, SeriesProgressInfo>|null} */ (null),
    [],
  );

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  return useMemo(
    () => ({
      map: snapshot ?? /** @type {Map<string, SeriesProgressInfo>} */ (new Map()),
      loading: snapshot === null,
    }),
    [snapshot],
  );
}

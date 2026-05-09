// @ts-check
import { useSyncExternalStore, useCallback, useRef, useMemo } from 'react';
import { liveQuery } from 'dexie';

/** @typedef {import('../lib/library/types').Series} Series */
/** @typedef {import('../lib/library/types').Progress} Progress */

/**
 * @typedef {Object} ResumeEntry
 * @property {Series} series
 * @property {number} episodeNumber
 * @property {number} lastTimeSec
 * @property {string} episodeId
 * @property {number} updatedAt
 */

/**
 * Subscribe to per-series "继续观看" entries.
 * Joins progress (latest per series) → series + episode, drops orphans / completed.
 *
 * @param {{ db: import('dexie').Dexie, limit?: number }} options
 * @returns {{ entries: ResumeEntry[], loading: boolean }}
 */
export default function useResume({ db, limit = 10 }) {
  /** @type {React.MutableRefObject<ResumeEntry[]|null>} */
  const snapshotRef = useRef(null);
  const snapshotKeyRef = useRef(/** @type {{ db: any, limit: number }|null} */(null));

  const subscribe = useCallback(
    (onChange) => {
      snapshotRef.current = null;
      snapshotKeyRef.current = { db, limit };

      const sub = liveQuery(async () => {
        const all = await db.progress.orderBy('updatedAt').reverse().toArray();

        /** @type {Map<string, Progress>} */
        const latestBySeries = new Map();
        for (const p of all) {
          if (p.completed) continue;
          if (!latestBySeries.has(p.seriesId)) {
            latestBySeries.set(p.seriesId, p);
            if (latestBySeries.size >= limit) break;
          }
        }

        const progressList = Array.from(latestBySeries.values());
        if (!progressList.length) return [];

        const seriesList = await db.series.bulkGet(progressList.map(p => p.seriesId));
        const episodeList = await db.episodes.bulkGet(progressList.map(p => p.episodeId));

        /** @type {ResumeEntry[]} */
        const out = [];
        for (let i = 0; i < progressList.length; i++) {
          const series = seriesList[i];
          const episode = episodeList[i];
          if (!series || !episode) continue;
          out.push({
            series,
            episodeNumber: episode.number,
            lastTimeSec: progressList[i].positionSec,
            episodeId: episode.id,
            updatedAt: progressList[i].updatedAt,
          });
        }
        return out;
      }).subscribe({
        next: (v) => {
          snapshotRef.current = v;
          onChange();
        },
        error: () => {
          snapshotRef.current = [];
          onChange();
        },
      });

      return () => sub.unsubscribe();
    },
    [db, limit],
  );

  const getSnapshot = useCallback(() => {
    const key = snapshotKeyRef.current;
    if (!key || key.db !== db || key.limit !== limit) return null;
    return snapshotRef.current;
  }, [db, limit]);

  const getServerSnapshot = useCallback(() => /** @type {ResumeEntry[]} */ ([]), []);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  return useMemo(
    () => ({
      entries: snapshot ?? [],
      loading: snapshot === null,
    }),
    [snapshot],
  );
}

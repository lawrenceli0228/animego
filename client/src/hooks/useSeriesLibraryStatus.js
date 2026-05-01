// @ts-check
import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';

/** @typedef {import('../lib/library/handles/probeRoot.js').RootStatus} RootStatus */
/** @typedef {'ok'|'partial'|'offline'|'unknown'} SeriesAvailability */

/**
 * Build a Map<seriesId, Set<libraryId>> via a live join of episodes →
 * fileRefs (joined by primaryFileId). Updates reactively when either table
 * changes.
 *
 * @param {{ db: import('dexie').Dexie }} options
 * @returns {Map<string, Set<string>>}
 */
function useSeriesLibraryIndex({ db }) {
  const [index, setIndex] = useState(/** @type {Map<string, Set<string>>} */ (new Map()));

  useEffect(() => {
    const sub = liveQuery(async () => {
      const [episodes, fileRefs] = await Promise.all([
        db.episodes.toArray(),
        db.fileRefs.toArray(),
      ]);
      const refById = new Map(fileRefs.map((r) => [r.id, r]));
      /** @type {Map<string, Set<string>>} */
      const map = new Map();
      for (const ep of episodes) {
        if (!ep?.seriesId || !ep.primaryFileId) continue;
        const ref = refById.get(ep.primaryFileId);
        if (!ref?.libraryId) continue;
        let set = map.get(ep.seriesId);
        if (!set) { set = new Set(); map.set(ep.seriesId, set); }
        set.add(ref.libraryId);
      }
      return map;
    }).subscribe({
      next: (v) => setIndex(v),
      error: () => setIndex(new Map()),
    });
    return () => sub.unsubscribe();
  }, [db]);

  return index;
}

/**
 * Combine the series→libraryIds index with per-library RootStatus to produce
 * a per-series availability label:
 *
 * - 'ok'      — every contributing library is 'ready'
 * - 'partial' — at least one library is 'ready' AND at least one is offline/denied/error
 * - 'offline' — every contributing library is offline/denied/error
 * - 'unknown' — series has no library refs (in-memory drop-zone import, etc.)
 *
 * @param {{
 *   db: import('dexie').Dexie,
 *   libraryStatus?: Map<string, RootStatus> | null,
 * }} options
 * @returns {{
 *   availabilityBySeries: Map<string, SeriesAvailability>,
 *   offlineLibraryIds: string[],
 * }}
 */
export default function useSeriesLibraryStatus({ db, libraryStatus }) {
  const seriesLibIds = useSeriesLibraryIndex({ db });
  const libStatus = libraryStatus instanceof Map ? libraryStatus : new Map();

  /** @type {Map<string, SeriesAvailability>} */
  const availabilityBySeries = new Map();
  for (const [seriesId, libs] of seriesLibIds) {
    if (libs.size === 0) {
      availabilityBySeries.set(seriesId, 'unknown');
      continue;
    }
    let anyOnline = false;
    let anyOffline = false;
    for (const libId of libs) {
      const st = libStatus.get(libId);
      if (st === 'ready') anyOnline = true;
      else if (st === 'disconnected' || st === 'denied' || st === 'error') anyOffline = true;
      // libraries we never probed (e.g. in-memory drop-zone "mem:" libraryIds)
      // don't move either flag — they'll stay 'unknown' below.
    }
    if (anyOnline && anyOffline) availabilityBySeries.set(seriesId, 'partial');
    else if (anyOffline) availabilityBySeries.set(seriesId, 'offline');
    else if (anyOnline) availabilityBySeries.set(seriesId, 'ok');
    else availabilityBySeries.set(seriesId, 'unknown');
  }

  const offlineLibraryIds = [];
  for (const [libId, st] of libStatus) {
    if (st === 'disconnected') offlineLibraryIds.push(libId);
  }

  return { availabilityBySeries, offlineLibraryIds };
}

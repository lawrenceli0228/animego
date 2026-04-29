// @ts-check
import { useState, useEffect, useCallback } from 'react';

/** @typedef {import('../lib/library/types').Series} Series */
/** @typedef {import('../lib/library/types').Episode} Episode */
/** @typedef {import('../lib/library/types').FileRef} FileRef */

/**
 * @typedef {'idle'|'loading'|'ready'|'error'|'missing'} SeriesDetailStatus
 */

/**
 * Loads a Series + its Episodes + their FileRefs from IDB. Lazily resolves
 * Files via FSA only on demand (returned `getFile(episodeId)`).
 *
 * @param {string|null} seriesId
 * @param {{ db: import('dexie').Dexie, fileHandles: { selectFileByName: (libraryId: string, relPath: string) => Promise<File|null> } }} ctx
 *
 * @returns {{
 *   status: SeriesDetailStatus,
 *   series: Series|null,
 *   episodes: Episode[],
 *   fileRefByEpisode: Map<string, FileRef>,
 *   getFile: (episodeId: string) => Promise<File|null>,
 *   refresh: () => void,
 * }}
 */
export default function useSeriesDetail(seriesId, { db, fileHandles }) {
  /** @type {[SeriesDetailStatus, React.Dispatch<React.SetStateAction<SeriesDetailStatus>>]} */
  const [status, setStatus] = useState(seriesId ? 'loading' : 'idle');
  const [series, setSeries] = useState(/** @type {Series|null} */ (null));
  const [episodes, setEpisodes] = useState(/** @type {Episode[]} */ ([]));
  const [fileRefByEpisode, setFileRefByEpisode] = useState(
    /** @type {Map<string, FileRef>} */ (new Map())
  );
  const [tick, setTick] = useState(0);

  /** Trigger a re-load by bumping the tick counter. */
  const refresh = useCallback(() => {
    setTick((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!seriesId || typeof seriesId !== 'string') {
      setStatus('idle');
      setSeries(null);
      setEpisodes([]);
      setFileRefByEpisode(new Map());
      return;
    }

    let cancelled = false;
    setStatus('loading');

    async function load() {
      try {
        // 1. Fetch series
        const seriesRecord = await db.series.get(seriesId);
        if (cancelled) return;
        if (!seriesRecord) {
          setStatus('missing');
          setSeries(null);
          setEpisodes([]);
          setFileRefByEpisode(new Map());
          return;
        }

        // 2. Fetch episodes for this series, sorted ascending by number
        const epRecords = await db.episodes
          .where('seriesId')
          .equals(seriesId)
          .toArray();
        if (cancelled) return;
        epRecords.sort((a, b) => a.number - b.number);

        // 3. Fetch fileRefs for each episode's primaryFileId
        const primaryFileIds = epRecords
          .map((ep) => ep.primaryFileId)
          .filter(Boolean);

        /** @type {Map<string, FileRef>} */
        const refMap = new Map();

        if (primaryFileIds.length) {
          const refs = await db.fileRefs
            .where('id')
            .anyOf(primaryFileIds)
            .toArray();
          if (cancelled) return;

          // Build map: episodeId → FileRef (via primaryFileId matching)
          const refById = new Map(refs.map((r) => [r.id, r]));
          for (const ep of epRecords) {
            if (ep.primaryFileId) {
              const ref = refById.get(ep.primaryFileId);
              if (ref) refMap.set(ep.id, ref);
            }
          }
        }

        if (cancelled) return;

        setSeries(seriesRecord);
        setEpisodes(epRecords);
        setFileRefByEpisode(refMap);
        setStatus('ready');
      } catch (_err) {
        if (!cancelled) {
          setStatus('error');
        }
      }
    }

    load();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesId, db, tick]);

  /**
   * Lazily resolve the File for an episode via FSA.
   * Returns null on any miss, permission denial, or error — never throws.
   *
   * @param {string} episodeId
   * @returns {Promise<File|null>}
   */
  const getFile = useCallback(
    async (episodeId) => {
      try {
        const fileRef = fileRefByEpisode.get(episodeId);
        if (!fileRef) return null;
        if (!fileRef.libraryId) return null;

        const file = await fileHandles.selectFileByName(
          fileRef.libraryId,
          fileRef.relPath
        );
        return file ?? null;
      } catch (_err) {
        return null;
      }
    },
    [fileRefByEpisode, fileHandles]
  );

  return { status, series, episodes, fileRefByEpisode, getFile, refresh };
}

// @ts-check
// Find Series records that share a Season.animeId and merge the duplicates
// via performMerge. The oldest Series (lowest createdAt) wins as the merge
// target so the most-watched / earliest-curated card keeps its progress and
// any user overrides.
//
// Used both as a manual "// 合并重复 //" button and as a one-shot fix for
// libraries imported before the in-batch dedup landed in importPipeline.

import { performMerge } from './mergeOps.js';

/**
 * @typedef {Object} DedupePair
 * @property {string} sourceSeriesId
 * @property {string} targetSeriesId
 * @property {number} animeId
 *
 * @typedef {Object} DedupeSummary
 * @property {number} groups          // distinct animeIds with ≥2 series
 * @property {number} merged          // performMerge ops actually appended
 * @property {number} skipped         // pairs already merged (no-op return)
 * @property {DedupePair[]} pairs     // every pair attempted
 * @property {string[]} opIds         // opsLog ids for undo
 */

/**
 * Scan IDB for Series sharing a Season.animeId and merge the duplicates.
 *
 * @param {{ db: import('dexie').Dexie }} input
 * @returns {Promise<DedupeSummary>}
 */
export async function dedupeSeriesByAnimeId({ db }) {
  if (!db) throw new Error('dedupeSeriesByAnimeId: db is required');

  const [allSeasons, allSeries] = await Promise.all([
    db.seasons.toArray(),
    db.series.toArray(),
  ]);

  /** @type {Map<string, {createdAt: number}>} */
  const seriesMeta = new Map(allSeries.map((s) => [s.id, { createdAt: s.createdAt ?? 0 }]));

  /** @type {Map<number, Set<string>>} animeId → Set<seriesId> */
  const groupsByAnimeId = new Map();
  for (const season of allSeasons) {
    if (typeof season.animeId !== 'number') continue;
    if (!season.seriesId) continue;
    let set = groupsByAnimeId.get(season.animeId);
    if (!set) { set = new Set(); groupsByAnimeId.set(season.animeId, set); }
    set.add(season.seriesId);
  }

  /** @type {DedupeSummary} */
  const summary = { groups: 0, merged: 0, skipped: 0, pairs: [], opIds: [] };

  for (const [animeId, seriesIds] of groupsByAnimeId) {
    if (seriesIds.size < 2) continue;
    summary.groups++;

    // Pick the oldest series as the target (lowest createdAt; ties broken by
    // id for determinism). This preserves the user's earliest progress data.
    const sorted = Array.from(seriesIds).sort((a, b) => {
      const ca = seriesMeta.get(a)?.createdAt ?? 0;
      const cb = seriesMeta.get(b)?.createdAt ?? 0;
      if (ca !== cb) return ca - cb;
      return a.localeCompare(b);
    });
    const target = sorted[0];
    const sources = sorted.slice(1);

    for (const source of sources) {
      summary.pairs.push({ sourceSeriesId: source, targetSeriesId: target, animeId });
      try {
        const op = await performMerge({
          db,
          sourceSeriesId: source,
          targetSeriesId: target,
          summary: { animeId, auto: true, reason: 'dedupeByAnimeId' },
        });
        if (op) {
          summary.merged++;
          summary.opIds.push(op.id);
        } else {
          summary.skipped++;
        }
      } catch (err) {
        // performMerge throws on validation issues only (bad inputs). Log and
        // keep going so one bad pair doesn't block the rest.
        console.warn('[dedupeSeries] merge failed', source, '→', target, err);
      }
    }
  }

  return summary;
}

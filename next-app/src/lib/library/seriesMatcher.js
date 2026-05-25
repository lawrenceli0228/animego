// @ts-check
// Pure function — no React, no IDB, no DOM, no async.
/** @typedef {import('./types').EpisodeItem} EpisodeItem */
/** @typedef {import('./types').MatchCluster} MatchCluster */
/** @typedef {import('./types').Season} Season */
/** @typedef {import('./types').MatchVerdict} MatchVerdict */

import { buildSeriesRecord, buildEpisodeRecord, buildFileRefRecord } from './recordFactory.js';

/**
 * Determine if an array of items has 3+ entries with consecutive episode numbers.
 * "Consecutive" means the sorted non-null episodes form a contiguous range with no gaps.
 * @param {EpisodeItem[]} items
 * @returns {boolean}
 */
function hasConsecutiveEpisodes(items) {
  const eps = items
    .map(it => it.episode)
    .filter(e => e !== null && e !== undefined)
    .map(Number)
    .sort((a, b) => a - b);

  if (eps.length < 3) return false;
  for (let i = 1; i < eps.length; i++) {
    if (eps[i] !== eps[i - 1] + 1) return false;
  }
  return true;
}

/**
 * Compute confidence score for a cluster.
 * - 0.9: ≥3 items with consecutive episode numbers and a resolved parsedTitle
 * - 0.7: has parsedTitle and episodeMap mostly contiguous (2+ items with episodes)
 * - 0.5: fallback (just parsedTitle, no ep#, or single item)
 *
 * @param {MatchCluster} cluster
 * @returns {number}
 */
function computeConfidence(cluster) {
  const hasTitle = !!cluster.representative?.parsedTitle;
  const { items } = cluster;

  if (hasTitle && hasConsecutiveEpisodes(items)) return 0.9;

  const withEp = items.filter(it => it.episode !== null && it.episode !== undefined);
  if (hasTitle && withEp.length >= 2) return 0.7;

  return 0.5;
}

/**
 * Match a single MatchCluster against prior seasons and build IDB records if needed.
 *
 * Context shape:
 * - priorSeasons: existing Season[] from IDB
 * - libraryId: the library being imported
 * - ulidSeed: optional seed for deterministic record ids (test mode)
 *
 * TODO (Commit B): 'ambiguous' verdict fires when dandanplay returns multiple candidates.
 *
 * @param {MatchCluster} cluster
 * @param {{ priorSeasons: Season[], libraryId: string, ulidSeed?: number }} ctx
 * @returns {MatchVerdict}
 */
export function matchSingleCluster(cluster, ctx) {
  const { priorSeasons, libraryId, ulidSeed } = ctx;

  // Guard: empty cluster
  if (!cluster.items || cluster.items.length === 0) {
    return { kind: 'failed', reason: 'empty cluster' };
  }

  // Reuse path: animeIdHint matches an existing season
  if (cluster.animeIdHint !== undefined) {
    const match = priorSeasons.find(s => s.animeId === cluster.animeIdHint);
    if (match) {
      return {
        kind: 'reuse',
        seriesId: match.seriesId,
        seasonId: match.id,
        animeId: match.animeId,
      };
    }
    // animeIdHint set but no matching season → fall through to 'new'
  }

  // New path: build records
  const confidence = computeConfidence(cluster);

  const seed = ulidSeed;
  const seriesRecord = buildSeriesRecord(cluster, { confidence, ulidSeed: seed });

  // episodeRecords: one per item (unique by fileId)
  const episodeRecords = [];
  const fileRefRecords = [];

  for (let i = 0; i < cluster.items.length; i++) {
    const it = cluster.items[i];
    const epSeed = seed !== undefined ? seed + 10 + i * 2 : undefined;
    const ep = buildEpisodeRecord({
      seriesId: seriesRecord.id,
      seasonId: null, // seasonId deferred until dandanplay confirms animeId (Commit B)
      item: it,
      ulidSeed: epSeed,
    });
    episodeRecords.push(ep);

    const fr = buildFileRefRecord({
      libraryId,
      episodeId: ep.id,
      item: it,
    });
    fileRefRecords.push(fr);
  }

  return {
    kind: 'new',
    seriesRecord,
    seasonRecord: null,
    episodeRecords,
    fileRefRecords,
    confidence,
  };
}

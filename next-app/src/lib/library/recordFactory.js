// @ts-check
// Pure function — no React, no IDB, no DOM, no async.
/** @typedef {import('./types').EpisodeItem} EpisodeItem */
/** @typedef {import('./types').MatchCluster} MatchCluster */
/** @typedef {import('./types').Series} Series */
/** @typedef {import('./types').Season} Season */
/** @typedef {import('./types').Episode} Episode */
/** @typedef {import('./types').FileRef} FileRef */

import { ulid } from './ulid.js';

/**
 * FNV-1a 32-bit hash → 8-char lowercase hex string.
 * Used for FileRef id when hash16M is present.
 * @param {string} str
 * @returns {string}
 */
function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (Math.imul(hash, 0x01000193) >>> 0);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Canonical FileRef id for an item. Single source of truth so that
 * Episode.primaryFileId and FileRef.id always agree.
 *
 * - With hash16M: `fnv1a(hash16M + '|' + size)` — stable across renames/moves.
 * - Without hash16M: soft id `fileName|size` — re-derives to the hash form
 *   automatically once the md5 worker fills in hash16M (see useImport hash phase).
 *
 * @param {EpisodeItem} item
 * @returns {string}
 */
export function fileRefId(item) {
  const size = item.file?.size ?? 0;
  if (item.hash16M) return fnv1a(`${item.hash16M}|${size}`);
  return `${item.fileName}|${size}`;
}

/**
 * v3.1: parse revision marker `[01v2]` / `01v2` / `E03v3` → version int.
 * Returns 1 when no marker present.
 * @param {string} fileName
 * @returns {number}
 */
export function parseVersion(fileName) {
  if (!fileName) return 1;
  const m = fileName.match(/\d+v(\d+)/i);
  if (!m) return 1;
  const v = Number.parseInt(m[1], 10);
  return Number.isFinite(v) && v >= 1 ? v : 1;
}

/**
 * Build a Series record from a MatchCluster.
 *
 * @param {MatchCluster} cluster
 * @param {{ confidence: number, ulidSeed?: number }} opts
 * @returns {Series}
 */
export function buildSeriesRecord(cluster, { confidence, ulidSeed }) {
  const now = Date.now();
  const id = ulid(ulidSeed);
  const title = cluster.representative?.parsedTitle ?? '';

  return {
    id,
    titleEn: title || undefined,
    titleZh: title || undefined,
    type: 'tv',
    confidence,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Build a Season record.
 *
 * @param {string} seriesId
 * @param {number} animeId
 * @param {{ ulidSeed?: number, number?: number }} [opts]
 * @returns {Season}
 */
export function buildSeasonRecord(seriesId, animeId, opts = {}) {
  const { ulidSeed, number: seasonNumber = 1 } = opts;
  const id = ulid(ulidSeed !== undefined ? ulidSeed + 1 : undefined);
  return {
    id,
    seriesId,
    number: seasonNumber,
    animeId,
    updatedAt: Date.now(),
  };
}

/**
 * Build an Episode record from an EpisodeItem.
 *
 * @param {{ seriesId: string, seasonId: string|null, item: EpisodeItem, ulidSeed?: number }} params
 * @returns {Episode}
 */
export function buildEpisodeRecord({ seriesId, seasonId, item, ulidSeed }) {
  const id = ulid(ulidSeed !== undefined ? ulidSeed + 2 : undefined);
  return {
    id,
    seriesId,
    ...(seasonId ? { seasonId } : {}),
    number: item.episode ?? 0,
    kind: /** @type {Episode['kind']} */ (item.parsedKind ?? 'main'),
    primaryFileId: fileRefId(item),
    alternateFileIds: [],
    version: parseVersion(item.fileName),
    updatedAt: Date.now(),
  };
}

/**
 * Build a FileRef record from an EpisodeItem.
 *
 * id derivation lives in `fileRefId()` so Episode.primaryFileId stays in sync.
 * When useImport's hash phase populates item.hash16M, the id flips from the
 * soft `name|size` form to the content-addressed `fnv1a(hash16M+size)` form
 * automatically — Episode.primaryFileId follows the same rule.
 *
 * @param {{ libraryId: string, episodeId: string|null, item: EpisodeItem }} params
 * @returns {FileRef}
 */
export function buildFileRefRecord({ libraryId, episodeId, item }) {
  const size = item.file?.size ?? 0;
  const id = fileRefId(item);

  /** @type {FileRef} */
  const ref = {
    id,
    libraryId,
    relPath: item.relativePath,
    size,
    mtime: item.file?.lastModified ?? 0,
    matchStatus: 'pending',
  };

  if (episodeId) ref.episodeId = episodeId;
  if (item.hash16M) ref.hash16M = item.hash16M;
  if (item.parsedResolution) ref.resolution = item.parsedResolution;
  if (item.parsedGroup) ref.group = item.parsedGroup;

  return ref;
}

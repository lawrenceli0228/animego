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
    primaryFileId: item.fileId,
    alternateFileIds: [],
    version: parseVersion(item.fileName),
    updatedAt: Date.now(),
  };
}

/**
 * Build a FileRef record from an EpisodeItem.
 *
 * When item.hash16M is present, id = fnv1a(hash16M + '|' + size).
 * Otherwise id = softId = `name|size` (P4 will rekey to hash(hash16M+size) once hash is computed).
 *
 * Note (P4 rekey): When the md5 worker completes hashing, callers must update this id
 * from the soft `name|size` format to `fnv1a(hash16M + '|' + size)` and update any
 * Episode.primaryFileId / Episode.alternateFileIds references accordingly.
 *
 * @param {{ libraryId: string, episodeId: string|null, item: EpisodeItem }} params
 * @returns {FileRef}
 */
export function buildFileRefRecord({ libraryId, episodeId, item }) {
  const size = item.file?.size ?? 0;

  let id;
  if (item.hash16M) {
    // Stable content-addressed id
    id = fnv1a(`${item.hash16M}|${size}`);
  } else {
    // Soft id — will be rekeyed in P4 once hash16M is available
    id = `${item.fileName}|${size}`;
  }

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

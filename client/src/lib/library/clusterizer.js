// @ts-check
// Pure function — no React, no IDB, no DOM, no async.
/** @typedef {import('./types').EpisodeItem} EpisodeItem */
/** @typedef {import('./types').Group} Group */
/** @typedef {import('./types').Season} Season */
/** @typedef {import('./types').MatchCluster} MatchCluster */

import { normalizeTokens } from './normalize.js';

/**
 * FNV-1a 32-bit hash → 8-char lowercase hex string.
 * No external deps; deterministic and fast for small strings.
 * @param {string} str
 * @returns {string}
 */
function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    // Unsigned 32-bit multiply
    hash = (Math.imul(hash, 0x01000193) >>> 0);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Select the representative item for a cluster:
 * - First item where episode != null AND parsedKind == 'main'
 * - Falls back to first item overall
 * @param {EpisodeItem[]} items
 * @returns {EpisodeItem|null}
 */
function pickRepresentative(items) {
  if (!items.length) return null;
  const main = items.find(it => it.episode !== null && it.parsedKind === 'main');
  return main ?? items[0];
}

/**
 * Sort EpisodeItems within a cluster: by groupKey first, then episode asc (null last), then fileName.
 * @param {EpisodeItem[]} items
 * @param {Group[]} groups
 * @returns {EpisodeItem[]}
 */
function sortClusterItems(items, groups) {
  // Build a map from fileId → groupKey for fast lookup
  /** @type {Map<string, string>} */
  const fileGroupKey = new Map();
  for (const g of groups) {
    for (const it of g.items) {
      fileGroupKey.set(it.fileId, g.groupKey);
    }
  }
  return [...items].sort((a, b) => {
    const ga = fileGroupKey.get(a.fileId) ?? '';
    const gb = fileGroupKey.get(b.fileId) ?? '';
    if (ga !== gb) return ga.localeCompare(gb);
    const ea = a.episode ?? Infinity;
    const eb = b.episode ?? Infinity;
    if (ea !== eb) return ea - eb;
    return a.fileName.localeCompare(b.fileName, undefined, { numeric: true });
  });
}

/**
 * Cluster a list of Groups by normalized parsedTitle.
 * Groups whose parsedTitle normalizes to the same token set are merged.
 * Groups with empty tokens become singleton clusters with clusterKey = groupKey.
 *
 * @param {Group[]} groups
 * @param {(Season & { _titleHint?: string })[]} [priorSeasons] - optional existing seasons for animeIdHint
 * @returns {MatchCluster[]}
 */
export function clusterize(groups, priorSeasons) {
  if (!groups || !groups.length) return [];

  // Build normalized-season lookup: normalizedKey → animeId
  /** @type {Map<string, number>} */
  const seasonIndex = new Map();
  if (priorSeasons && priorSeasons.length) {
    for (const s of priorSeasons) {
      const hint = /** @type {any} */ (s)._titleHint ?? '';
      if (hint) {
        const tokens = normalizeTokens(hint);
        if (tokens.length) {
          seasonIndex.set(tokens.join('|'), s.animeId);
        }
      }
    }
  }

  /** @type {Map<string, { tokens: string[], groups: Group[] }>} */
  const buckets = new Map();
  /** Preserve insertion order of bucket keys */
  const bucketOrder = [];

  for (const g of groups) {
    // Derive tokens from first item's parsedTitle, fallback to group label
    const source = g.items[0]?.parsedTitle ?? g.label ?? '';
    const tokens = normalizeTokens(source);

    if (!tokens.length) {
      // Singleton — use groupKey as unique bucket key
      const key = g.groupKey;
      buckets.set(key, { tokens: [], groups: [g] });
      bucketOrder.push(key);
      continue;
    }

    const bucketKey = tokens.join('|');
    if (!buckets.has(bucketKey)) {
      buckets.set(bucketKey, { tokens, groups: [] });
      bucketOrder.push(bucketKey);
    }
    buckets.get(bucketKey).groups.push(g);
  }

  /** @type {MatchCluster[]} */
  const clusters = [];

  for (const key of bucketOrder) {
    const { tokens, groups: bucketGroups } = buckets.get(key);

    const clusterKey = tokens.length ? fnv1a(key) : key;

    const allItems = bucketGroups.flatMap(g => g.items);
    const items = sortClusterItems(allItems, bucketGroups);
    const representative = pickRepresentative(items);

    // Check for animeIdHint
    let animeIdHint;
    if (tokens.length && seasonIndex.has(key)) {
      animeIdHint = seasonIndex.get(key);
    }

    /** @type {MatchCluster} */
    const cluster = {
      clusterKey,
      normalizedTokens: tokens,
      groups: bucketGroups,
      items,
      representative,
    };

    if (animeIdHint !== undefined) {
      cluster.animeIdHint = animeIdHint;
    }

    clusters.push(cluster);
  }

  return clusters;
}

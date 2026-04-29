// @ts-check
// Pure function — no React, no IDB, no DOM, no async.
// P3 SeriesMatcher imports this directly.
/** @typedef {import('./types').EpisodeItem} EpisodeItem */
/** @typedef {import('./types').Group} Group */

/**
 * Derive the directory key from a relativePath.
 * @param {string} relativePath
 * @returns {string}
 */
function deriveGroupKey(relativePath) {
  const slashIdx = relativePath.lastIndexOf('/');
  if (slashIdx === -1) return '__root__';
  return relativePath.slice(0, slashIdx);
}

/**
 * Detect whether a set of items has ambiguous episode numbering.
 *
 * Triggers:
 *  1. Two items share the same non-null episode number but have different parsedKind.
 *  2. Mixed kinds ⊂ {main,sp,ova} where main has gaps and sp/ova fill those numbers.
 *
 * @param {EpisodeItem[]} items
 * @returns {boolean}
 */
function detectAmbiguity(items) {
  // Build map: episode → set of kinds (for non-null episodes only)
  /** @type {Map<number, Set<string>>} */
  const epKinds = new Map();
  for (const it of items) {
    if (it.episode === null) continue;
    if (!epKinds.has(it.episode)) epKinds.set(it.episode, new Set());
    epKinds.get(it.episode).add(it.parsedKind);
  }

  // Trigger 1: same episode, different kind
  for (const kinds of epKinds.values()) {
    if (kinds.size > 1) return true;
  }

  // Trigger 2: mixed {main,sp,ova} where main has gaps filled by sp/ova
  const ambiguousKindSet = new Set(['main', 'sp', 'ova']);
  const presentKinds = new Set(items.map((i) => i.parsedKind));
  const hasMixedSubset =
    presentKinds.has('main') &&
    (presentKinds.has('sp') || presentKinds.has('ova')) &&
    [...presentKinds].every((k) => ambiguousKindSet.has(k));

  if (hasMixedSubset) {
    const mainEps = new Set(
      items.filter((i) => i.parsedKind === 'main' && i.episode !== null).map((i) => i.episode),
    );
    if (mainEps.size >= 2) {
      const min = Math.min(...mainEps);
      const max = Math.max(...mainEps);
      // Check if any integer in [min,max] is missing from main
      for (let ep = min; ep <= max; ep++) {
        if (!mainEps.has(ep)) return true;
      }
    }
  }

  return false;
}

/**
 * @param {EpisodeItem} a
 * @param {EpisodeItem} b
 * @returns {number}
 */
function sortByEpisodeThenName(a, b) {
  const ea = a.episode ?? Infinity;
  const eb = b.episode ?? Infinity;
  if (ea !== eb) return ea - eb;
  return a.fileName.localeCompare(b.fileName, undefined, { numeric: true });
}

/**
 * Group a flat list of EpisodeItems by their directory (webkitRelativePath dirname).
 * Returns Group[] sorted by items.length desc, then groupKey asc.
 *
 * @param {EpisodeItem[]} items
 * @returns {Group[]}
 */
export function groupByFolder(items) {
  if (!items.length) return [];

  // Bucket items by groupKey (preserving input order within each bucket)
  /** @type {Map<string, EpisodeItem[]>} */
  const buckets = new Map();
  for (const it of items) {
    const key = deriveGroupKey(it.relativePath);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(it);
  }

  // Build Group objects
  /** @type {Group[]} */
  const groups = [];
  for (const [groupKey, raw] of buckets) {
    const hasAmbiguity = detectAmbiguity(raw);
    const sortMode = hasAmbiguity ? 'alpha' : 'episode';
    const sorted = [...raw].sort(
      sortMode === 'alpha'
        ? (a, b) => a.fileName.localeCompare(b.fileName, undefined, { numeric: true })
        : sortByEpisodeThenName,
    );
    const lastSeg = groupKey.split('/').pop();
    // id is deterministic from groupKey so this stays a pure function — P3 SeriesMatcher
    // can use it as a stable merge key across re-groupings of the same files.
    // label for __root__ is the sentinel itself; UI layer translates.
    groups.push({
      id: `g:${groupKey}`,
      groupKey,
      label: lastSeg,
      items: sorted,
      sortMode,
      hasAmbiguity,
    });
  }

  // Sort groups: items.length desc, then groupKey asc
  groups.sort((a, b) => {
    if (b.items.length !== a.items.length) return b.items.length - a.items.length;
    return a.groupKey.localeCompare(b.groupKey);
  });

  return groups;
}

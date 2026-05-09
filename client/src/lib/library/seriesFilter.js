// @ts-check
/** @typedef {import('./types').Series} Series */
/** @typedef {import('../../hooks/useSeriesProgressMap').SeriesProgressInfo} SeriesProgressInfo */
/** @typedef {'recent'|'new'|'inProgress'|'done'|'almostDone'|'stalled'|'fresh'|null} LibraryFilter */

const DAY_MS = 24 * 60 * 60 * 1000;
const STALLED_AFTER_DAYS = 7;
const ALMOST_DONE_RATIO = 0.8;
const FRESH_RATIO = 0.1;

/**
 * Decide whether a series matches the active filter, ignoring text query.
 * Extracted so the chip-count memo can reuse the same logic without re-running
 * the sort/slice path.
 *
 * @param {Series} s
 * @param {Map<string, SeriesProgressInfo>} progressMap
 * @param {Exclude<LibraryFilter, null>} filter
 * @returns {boolean}
 */
export function matchesFilter(s, progressMap, filter) {
  if (filter === 'new') return true;
  const info = progressMap.get(s.id);

  if (filter === 'recent') {
    return (info?.lastPlayedAt ?? 0) > 0;
  }
  if (filter === 'inProgress') {
    if (!info || info.watchedCount <= 0) return false;
    const total = typeof s.totalEpisodes === 'number' ? s.totalEpisodes : 0;
    if (total <= 0) return true;
    return info.completedCount < total;
  }
  if (filter === 'done') {
    if (!info) return false;
    const total = typeof s.totalEpisodes === 'number' ? s.totalEpisodes : 0;
    if (total <= 0) return false;
    return info.completedCount >= total;
  }
  if (filter === 'almostDone') {
    // ≥80% watched but not yet complete — "one push away from done".
    if (!info) return false;
    const total = typeof s.totalEpisodes === 'number' ? s.totalEpisodes : 0;
    if (total <= 0) return false;
    const ratio = info.watchedCount / total;
    return ratio >= ALMOST_DONE_RATIO && info.completedCount < total;
  }
  if (filter === 'stalled') {
    // Mid-progress (10%-80%) AND nothing watched in the last 7 days. Caller's
    // common surprise here is "stalled" looks empty until they go stale —
    // intentional: not every paused show is stuck.
    if (!info || info.watchedCount <= 0) return false;
    const total = typeof s.totalEpisodes === 'number' ? s.totalEpisodes : 0;
    if (total <= 0) return false;
    const ratio = info.watchedCount / total;
    if (ratio < FRESH_RATIO || ratio >= ALMOST_DONE_RATIO) return false;
    if (info.completedCount >= total) return false;
    const stale = Date.now() - (info.lastPlayedAt ?? 0) > STALLED_AFTER_DAYS * DAY_MS;
    return stale;
  }
  if (filter === 'fresh') {
    // Started but barely — <10% watched, under "刚开始" threshold.
    if (!info || info.watchedCount <= 0) return false;
    const total = typeof s.totalEpisodes === 'number' ? s.totalEpisodes : 0;
    if (total <= 0) return true;
    return info.watchedCount / total < FRESH_RATIO;
  }
  return true;
}

/**
 * Lowercased haystack: titleZh + titleEn + titleJa joined. Cached per call —
 * cheap allocation, called only when query is non-empty.
 *
 * @param {Series} s
 */
function searchHaystack(s) {
  return [s.titleZh, s.titleEn, s.titleJa]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/**
 * Pure projection: filter + sort + optional text search.
 *
 * Filters:
 *   recent     → only series with progress, sorted by lastPlayedAt desc
 *   new        → all series, sorted by createdAt desc
 *   inProgress → watched > 0 AND completed < total
 *   done       → completed >= total (and total > 0)
 *   almostDone → watched ratio ≥ 80%, not yet complete
 *   stalled    → 10%-80% watched AND not touched in last 7 days
 *   fresh      → watched ratio < 10%
 *   null       → all series, original order preserved
 *
 * Text query: case-insensitive substring match against titleZh+titleEn+titleJa,
 * applied after the filter narrows the set. Empty/whitespace query is no-op.
 *
 * @param {Series[]} series
 * @param {Map<string, SeriesProgressInfo>} progressMap
 * @param {LibraryFilter} filter
 * @param {string} [query] — optional text search across titles
 * @returns {Series[]}
 */
export function applySeriesFilter(series, progressMap, filter, query) {
  /** @type {Series[]} */
  let out;
  if (filter === null || filter === undefined) {
    out = series.slice();
  } else if (filter === 'new') {
    out = series.slice().sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  } else if (filter === 'recent') {
    out = series
      .filter((s) => (progressMap.get(s.id)?.lastPlayedAt ?? 0) > 0)
      .sort((a, b) => {
        const ai = progressMap.get(a.id)?.lastPlayedAt ?? 0;
        const bi = progressMap.get(b.id)?.lastPlayedAt ?? 0;
        return bi - ai;
      });
  } else {
    out = series.filter((s) => matchesFilter(s, progressMap, filter));
  }

  const q = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (!q) return out;
  return out.filter((s) => searchHaystack(s).includes(q));
}

/**
 * Compute per-chip counts for the FilterChips telemetry switcher. Cheap O(n)
 * pass — call inside a useMemo keyed on series + progressMap.
 *
 * @param {Series[]} series
 * @param {Map<string, SeriesProgressInfo>} progressMap
 * @returns {Record<Exclude<LibraryFilter, null>, number>}
 */
export function computeFilterCounts(series, progressMap) {
  /** @type {Record<Exclude<LibraryFilter, null>, number>} */
  const counts = {
    recent: 0,
    new: series.length,
    inProgress: 0,
    done: 0,
    almostDone: 0,
    stalled: 0,
    fresh: 0,
  };
  for (const s of series) {
    if (matchesFilter(s, progressMap, 'recent')) counts.recent++;
    if (matchesFilter(s, progressMap, 'inProgress')) counts.inProgress++;
    if (matchesFilter(s, progressMap, 'done')) counts.done++;
    if (matchesFilter(s, progressMap, 'almostDone')) counts.almostDone++;
    if (matchesFilter(s, progressMap, 'stalled')) counts.stalled++;
    if (matchesFilter(s, progressMap, 'fresh')) counts.fresh++;
  }
  return counts;
}

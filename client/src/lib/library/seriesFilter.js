// @ts-check
/** @typedef {import('./types').Series} Series */
/** @typedef {import('../../hooks/useSeriesProgressMap').SeriesProgressInfo} SeriesProgressInfo */
/** @typedef {'recent'|'new'|'inProgress'|'done'|null} LibraryFilter */

/**
 * Pure projection: take the full series list and return the subset/order that
 * matches the active library filter chip (§5.4).
 *
 *   recent     → only series with progress, sorted by lastPlayedAt desc
 *   new        → all series, sorted by createdAt desc
 *   inProgress → only series with watched > 0 AND completed < total
 *   done       → only series where completed >= total (and total > 0)
 *   null       → all series, original order preserved
 *
 * Kept dependency-free of React so it's trivially testable in isolation.
 *
 * @param {Series[]} series
 * @param {Map<string, SeriesProgressInfo>} progressMap
 * @param {LibraryFilter} filter
 * @returns {Series[]}
 */
export function applySeriesFilter(series, progressMap, filter) {
  if (filter === null || filter === undefined) return series.slice();
  if (filter === 'new') {
    return series.slice().sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }
  if (filter === 'recent') {
    return series
      .filter((s) => (progressMap.get(s.id)?.lastPlayedAt ?? 0) > 0)
      .sort((a, b) => {
        const ai = progressMap.get(a.id)?.lastPlayedAt ?? 0;
        const bi = progressMap.get(b.id)?.lastPlayedAt ?? 0;
        return bi - ai;
      });
  }
  if (filter === 'inProgress') {
    return series.filter((s) => {
      const info = progressMap.get(s.id);
      if (!info || info.watchedCount <= 0) return false;
      const total = typeof s.totalEpisodes === 'number' ? s.totalEpisodes : 0;
      if (total <= 0) return true;
      return info.completedCount < total;
    });
  }
  if (filter === 'done') {
    return series.filter((s) => {
      const info = progressMap.get(s.id);
      if (!info) return false;
      const total = typeof s.totalEpisodes === 'number' ? s.totalEpisodes : 0;
      if (total <= 0) return false;
      return info.completedCount >= total;
    });
  }
  return series.slice();
}

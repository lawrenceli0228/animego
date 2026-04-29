// @ts-check
// Pure data layer — no React, no DOM.
/** @typedef {import('../types').Season} Season */

/**
 * Create a seasonRepo bound to the given Dexie database instance.
 *
 * @param {import('dexie').Dexie} db
 * @returns {{
 *   findByAnimeId(animeId: number): Promise<Season[]>,
 *   findBySeries(seriesId: string): Promise<Season[]>
 * }}
 */
export function makeSeasonRepo(db) {
  /**
   * Return all seasons with the given dandanplay animeId.
   * @param {number} animeId
   * @returns {Promise<Season[]>}
   */
  async function findByAnimeId(animeId) {
    return db.seasons.where('animeId').equals(animeId).toArray();
  }

  /**
   * Return all seasons belonging to a series.
   * @param {string} seriesId
   * @returns {Promise<Season[]>}
   */
  async function findBySeries(seriesId) {
    return db.seasons.where('seriesId').equals(seriesId).toArray();
  }

  return { findByAnimeId, findBySeries };
}

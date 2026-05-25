// @ts-check
// Pure data layer — no React, no DOM.
/** @typedef {import('../types').Series} Series */
/** @typedef {import('../types').Season} Season */
/** @typedef {import('../types').Episode} Episode */
/** @typedef {import('../types').FileRef} FileRef */

/**
 * @typedef {Object} ClusterPayload
 * @property {Series}   series
 * @property {Season}   [season]
 * @property {Episode[]} episodes
 * @property {FileRef[]} fileRefs
 */

/**
 * Validate that a ClusterPayload has the required minimum fields.
 * Throws a clear Error if validation fails.
 * @param {ClusterPayload} payload
 */
function validatePayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('seriesRepo.upsertCluster: payload must be an object');
  }
  if (!payload.series || typeof payload.series.id !== 'string' || !payload.series.id) {
    throw new Error('seriesRepo.upsertCluster: payload.series.id is required');
  }
  if (!Array.isArray(payload.episodes)) {
    throw new Error('seriesRepo.upsertCluster: payload.episodes must be an array');
  }
  if (!Array.isArray(payload.fileRefs)) {
    throw new Error('seriesRepo.upsertCluster: payload.fileRefs must be an array');
  }
}

/**
 * Create a seriesRepo bound to the given Dexie database instance.
 *
 * @param {import('dexie').Dexie} db
 * @returns {{
 *   findAll(): Promise<Series[]>,
 *   findById(id: string): Promise<Series|null>,
 *   upsertCluster(payload: ClusterPayload): Promise<void>
 * }}
 */
export function makeSeriesRepo(db) {
  /**
   * Return all series sorted by updatedAt descending.
   * @returns {Promise<Series[]>}
   */
  async function findAll() {
    const all = await db.series.orderBy('updatedAt').toArray();
    return all.reverse();
  }

  /**
   * Return a single series by id, or null if not found.
   * @param {string} id
   * @returns {Promise<Series|null>}
   */
  async function findById(id) {
    const record = await db.series.get(id);
    return record ?? null;
  }

  /**
   * Write all cluster records (series, optional season, episodes, fileRefs) in one
   * Dexie transaction across all four tables. Idempotent — re-upserting with the
   * same ids performs a last-write-wins merge on updatedAt.
   *
   * @param {ClusterPayload} payload
   * @returns {Promise<void>}
   */
  async function upsertCluster(payload) {
    validatePayload(payload);
    const { series, season, episodes, fileRefs } = payload;

    await db.transaction('rw', [db.series, db.seasons, db.episodes, db.fileRefs], async () => {
      await db.series.put(series);

      if (season) {
        await db.seasons.put(season);
      }

      if (episodes.length) {
        await db.episodes.bulkPut(episodes);
      }

      if (fileRefs.length) {
        await db.fileRefs.bulkPut(fileRefs);
      }
    });
  }

  return { findAll, findById, upsertCluster };
}

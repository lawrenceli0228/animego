// @ts-check
// Pure data layer — no React, no DOM.
/** @typedef {import('../types').Progress} Progress */

/**
 * Validate a Progress record before write. Throws on bad input.
 * @param {Progress} p
 */
function validate(p) {
  if (!p || typeof p !== 'object') {
    throw new Error('progressRepo.put: progress must be an object');
  }
  if (typeof p.episodeId !== 'string' || !p.episodeId) {
    throw new Error('progressRepo.put: episodeId is required');
  }
  if (typeof p.seriesId !== 'string' || !p.seriesId) {
    throw new Error('progressRepo.put: seriesId is required');
  }
  if (typeof p.positionSec !== 'number' || p.positionSec < 0 || !Number.isFinite(p.positionSec)) {
    throw new Error('progressRepo.put: positionSec must be a non-negative finite number');
  }
  if (typeof p.durationSec !== 'number' || p.durationSec <= 0 || !Number.isFinite(p.durationSec)) {
    throw new Error('progressRepo.put: durationSec must be a positive finite number');
  }
}

/**
 * Create a progressRepo bound to the given Dexie database instance (v5+).
 *
 * @param {import('dexie').Dexie} db
 * @param {{ now?: () => number }} [opts]
 * @returns {{
 *   get(episodeId: string): Promise<Progress|null>,
 *   put(progress: Progress): Promise<void>,
 *   getBySeries(seriesId: string): Promise<Progress[]>,
 *   latestPerSeries(opts?: { limit?: number }): Promise<Progress[]>,
 *   delete(episodeId: string): Promise<void>
 * }}
 */
export function makeProgressRepo(db, { now = () => Date.now() } = {}) {
  /**
   * Read a single progress record by episodeId.
   * @param {string} episodeId
   */
  async function get(episodeId) {
    const rec = await db.progress.get(episodeId);
    return rec ?? null;
  }

  /**
   * Upsert a progress record. Last-write-wins on episodeId.
   * If `updatedAt` is omitted, the injected clock is used.
   * @param {Progress} progress
   */
  async function put(progress) {
    validate(progress);
    const updatedAt = typeof progress.updatedAt === 'number' ? progress.updatedAt : now();
    await db.progress.put({ ...progress, updatedAt });
  }

  /**
   * All progress records for a series, sorted by updatedAt descending.
   * @param {string} seriesId
   */
  async function getBySeries(seriesId) {
    // Composite index [seriesId+updatedAt] gives an in-IDB sort.
    const rows = await db.progress
      .where('[seriesId+updatedAt]')
      .between([seriesId, -Infinity], [seriesId, Infinity])
      .toArray();
    rows.sort((a, b) => b.updatedAt - a.updatedAt);
    return rows;
  }

  /**
   * Latest progress per series, newest first. Used by the "继续观看" row on the Library page.
   * @param {{ limit?: number }} [opts]
   */
  async function latestPerSeries({ limit = 20 } = {}) {
    const all = await db.progress.orderBy('updatedAt').reverse().toArray();
    /** @type {Map<string, Progress>} */
    const seen = new Map();
    for (const rec of all) {
      if (!seen.has(rec.seriesId)) {
        seen.set(rec.seriesId, rec);
        if (seen.size >= limit) break;
      }
    }
    return Array.from(seen.values());
  }

  /**
   * Remove a single progress record.
   * @param {string} episodeId
   */
  async function del(episodeId) {
    await db.progress.delete(episodeId);
  }

  return { get, put, getBySeries, latestPerSeries, delete: del };
}

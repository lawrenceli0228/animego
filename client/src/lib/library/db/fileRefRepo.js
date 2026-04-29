// @ts-check
// Pure data layer — no React, no DOM.
/** @typedef {import('../types').FileRef} FileRef */

/**
 * Create a fileRefRepo bound to the given Dexie database instance.
 *
 * @param {import('dexie').Dexie} db
 * @returns {{
 *   findByMatchStatus(libraryId: string, status: string): Promise<FileRef[]>,
 *   setEpisode(fileRefId: string, episodeId: string): Promise<void>,
 *   markMissing(id: string): Promise<void>
 * }}
 */
export function makeFileRefRepo(db) {
  /**
   * Return fileRefs for a library filtered by matchStatus.
   * Uses the [libraryId+matchStatus] compound index for efficient lookup.
   *
   * @param {string} libraryId
   * @param {string} status
   * @returns {Promise<FileRef[]>}
   */
  async function findByMatchStatus(libraryId, status) {
    return db.fileRefs
      .where('[libraryId+matchStatus]')
      .equals([libraryId, status])
      .toArray();
  }

  /**
   * Set (or update) the episodeId on an existing fileRef.
   * @param {string} fileRefId
   * @param {string} episodeId
   * @returns {Promise<void>}
   */
  async function setEpisode(fileRefId, episodeId) {
    await db.fileRefs.update(fileRefId, { episodeId });
  }

  /**
   * Mark a fileRef as failed and clear its episodeId.
   * Sets matchStatus='failed' and removes the episodeId field.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async function markMissing(id) {
    await db.fileRefs.update(id, { matchStatus: 'failed', episodeId: undefined });
  }

  return { findByMatchStatus, setEpisode, markMissing };
}

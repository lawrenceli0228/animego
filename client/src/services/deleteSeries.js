// @ts-check
// Cascade-delete a Series and every IDB record that references it.
//
// - series row
// - all seasons under the series
// - all episodes under the series
// - fileRefs whose primaryFileId / alternateFileIds match those episodes
//   (only when no other series references the same fileRef — cross-folder
//    merges share refs)
// - progress rows for those episodes (and the seriesId-keyed ones)
// - userOverride row keyed by seriesId
//
// We never touch fileHandles (root directory grants persist across imports
// since the user already authorized them) and never touch matchCache (its
// hash16M lookups are safe to keep — duplicate imports skip the dandanplay
// round-trip thanks to the cache).
//
// On-disk video files are NEVER deleted — the user's media is theirs.

/**
 * @typedef {Object} DeleteSummary
 * @property {string}  seriesId
 * @property {number}  episodes      episodes removed
 * @property {number}  seasons       seasons removed
 * @property {number}  fileRefs      fileRefs removed
 * @property {number}  progress      progress rows removed
 * @property {boolean} userOverride  was a userOverride row removed
 */

/**
 * Delete a Series and its dependencies. Idempotent — calling on a missing
 * seriesId returns a zero-summary instead of throwing.
 *
 * @param {{ db: import('dexie').Dexie, seriesId: string }} input
 * @returns {Promise<DeleteSummary>}
 */
export async function deleteSeriesCascade({ db, seriesId }) {
  if (typeof seriesId !== 'string' || !seriesId) {
    throw new Error('deleteSeriesCascade: seriesId must be a non-empty string');
  }

  /** @type {DeleteSummary} */
  const summary = {
    seriesId,
    episodes: 0,
    seasons: 0,
    fileRefs: 0,
    progress: 0,
    userOverride: false,
  };

  const seriesRow = await db.series.get(seriesId);
  if (!seriesRow) return summary;

  const episodes = await db.episodes.where('seriesId').equals(seriesId).toArray();
  const seasons  = await db.seasons.where('seriesId').equals(seriesId).toArray();

  // Collect the fileRef ids those episodes reference. An episode can list
  // both a primaryFileId and one or more alternateFileIds (cross-folder
  // duplicates / multi-resolution).
  const fileRefIds = new Set();
  for (const ep of episodes) {
    if (ep.primaryFileId) fileRefIds.add(ep.primaryFileId);
    if (Array.isArray(ep.alternateFileIds)) {
      for (const fid of ep.alternateFileIds) fileRefIds.add(fid);
    }
  }

  // Don't delete a fileRef that some OTHER series still owns (post-merge
  // edge case): scan other series' episodes for any of these ids.
  /** @type {Set<string>} */
  const sharedRefIds = new Set();
  if (fileRefIds.size > 0) {
    const otherEpisodes = await db.episodes
      .where('seriesId')
      .notEqual(seriesId)
      .toArray();
    for (const ep of otherEpisodes) {
      if (ep.primaryFileId && fileRefIds.has(ep.primaryFileId)) {
        sharedRefIds.add(ep.primaryFileId);
      }
      if (Array.isArray(ep.alternateFileIds)) {
        for (const fid of ep.alternateFileIds) {
          if (fileRefIds.has(fid)) sharedRefIds.add(fid);
        }
      }
    }
  }
  const ownedRefIds = Array.from(fileRefIds).filter((id) => !sharedRefIds.has(id));

  // Single transaction over every table we mutate so a mid-flight failure
  // doesn't leave the library in a half-deleted state.
  await db.transaction(
    'rw',
    [db.series, db.seasons, db.episodes, db.fileRefs, db.progress, db.userOverride],
    async () => {
      if (ownedRefIds.length > 0) {
        await db.fileRefs.bulkDelete(ownedRefIds);
        summary.fileRefs = ownedRefIds.length;
      }
      if (episodes.length > 0) {
        await db.episodes.bulkDelete(episodes.map((e) => e.id));
        summary.episodes = episodes.length;
      }
      if (seasons.length > 0) {
        await db.seasons.bulkDelete(seasons.map((s) => s.id));
        summary.seasons = seasons.length;
      }
      const progressDeleted = await db.progress.where('seriesId').equals(seriesId).delete();
      summary.progress = progressDeleted;

      const overrideDeleted = await db.userOverride.where('seriesId').equals(seriesId).delete();
      summary.userOverride = overrideDeleted > 0;

      await db.series.delete(seriesId);
    },
  );

  return summary;
}

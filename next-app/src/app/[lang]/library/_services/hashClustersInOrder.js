// @ts-check
// Hash a batch's files in the order its clusters are imported.
//
// A cluster cannot be imported before its files are hashed: dandanplay matches
// on the hash of a file's first 16MB, and the hash keys the file's row. The
// import used to hash the whole batch first, so a few hundred files on an
// external drive kept the library empty for half a minute or more, and the
// matches only started after the last file was read.
//
// Clustering needs no hashes (it reads folders and parsed titles), so the
// clusters are formed first. Every file is then queued for hashing in cluster
// order, and each cluster waits only for its own files: the first card lands
// once the first cluster is read, and later clusters are read while earlier
// ones are matched.

/** @typedef {import('@/lib/library/types').EpisodeItem} EpisodeItem */
/** @typedef {import('@/lib/library/types').MatchCluster} MatchCluster */

/**
 * @param {MatchCluster[]} clusters  in the order they will be imported
 * @param {((file: File) => Promise<string>) | undefined} hashFile  resolves
 *   '' when the file could not be hashed
 * @returns {(cluster: MatchCluster) => Promise<MatchCluster>} the cluster with
 *   its items hashed; without `hashFile`, the cluster as it is
 */
export function hashClustersInOrder(clusters, hashFile) {
  if (!hashFile) return async (cluster) => cluster;

  /** @type {Map<EpisodeItem, Promise<EpisodeItem>>} */
  const hashed = new Map();
  for (const cluster of clusters) {
    for (const item of cluster.items ?? []) {
      if (!hashed.has(item)) hashed.set(item, withHash(item, hashFile));
    }
  }

  return async (cluster) => {
    const items = cluster.items ?? [];
    const done = await Promise.all(
      items.map((item) => hashed.get(item) ?? withHash(item, hashFile)),
    );
    const swap = new Map(items.map((item, i) => [item, done[i]]));
    /** @param {EpisodeItem} item */
    const of = (item) => swap.get(item) ?? item;
    return {
      ...cluster,
      items: items.map(of),
      groups: (cluster.groups ?? []).map((group) => ({ ...group, items: group.items.map(of) })),
      representative: cluster.representative ? of(cluster.representative) : cluster.representative,
    };
  };
}

/**
 * A file that cannot be hashed is imported without one, as before: under a
 * name-and-size id (recordFactory.fileRefId) instead of a content id.
 *
 * @param {EpisodeItem} item
 * @param {(file: File) => Promise<string>} hashFile
 * @returns {Promise<EpisodeItem>}
 */
async function withHash(item, hashFile) {
  if (item.hash16M || !item.file) return item;
  try {
    const hash = await hashFile(/** @type {File} */ (item.file));
    return hash ? { ...item, hash16M: hash } : item;
  } catch (err) {
    console.warn('[importPipeline] hashing failed; importing without a hash:', item.relativePath, err);
    return item;
  }
}

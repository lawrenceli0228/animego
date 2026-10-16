// @ts-check
// Split a cluster where its folders name different shows.
//
// The clusterizer merges folders whose titles normalize alike, and dandanplay
// is asked about one file per cluster. A first season's folder and a sequel's
// "Show - 16" at the root share a title, so they became one cluster, and on a
// first import the whole cluster became one card named and bound by whichever
// file was asked — the root sorts first, so the sequel's. The first season
// showed up inside the second.
//
// Here each folder answers for itself before the cluster is matched: one file
// per folder (or, for a folder the library already filed, the binding of the
// card it is on). Folders whose answers name a different show from the
// representative's folder are split off into a cluster of their own. Only a
// positive disagreement splits: a folder with no answer stays where the title
// put it, because an unindexed folder of the same show would otherwise become
// a second card nothing can fold back.

import { clusterOfGroups, pickRepresentative } from '@/lib/library/clusterizer.js';

/** @typedef {import('@/lib/library/types').EpisodeItem} EpisodeItem */
/** @typedef {import('@/lib/library/types').Group} Group */
/** @typedef {import('@/lib/library/types').MatchCluster} MatchCluster */

/**
 * The AniList id a folder's files belong to, or undefined when nothing says.
 * @typedef {(items: EpisodeItem[], rep: EpisodeItem) => Promise<number|undefined>} FolderIdentity
 */

const ROOT = '__root__';

/**
 * Loose files at the root are one group each (grouping.js), but they share a
 * folder: they answer together.
 * @param {Group} group
 */
function folderOf(group) {
  return group.groupKey.startsWith(ROOT) ? ROOT : group.groupKey;
}

/**
 * Only a main episode can speak for a folder. A special or a movie is often an
 * AniList entry of its own, and it belongs with its show.
 * @param {EpisodeItem|null} rep
 * @returns {rep is EpisodeItem}
 */
function canSpeak(rep) {
  return rep != null && rep.episode != null && (rep.parsedKind ?? 'main') === 'main';
}

/** @param {unknown} id */
function isAnilistId(id) {
  return typeof id === 'number' && Number.isInteger(id) && id > 0;
}

/**
 * @param {MatchCluster} cluster
 * @param {FolderIdentity} identify
 * @returns {Promise<MatchCluster[]>} the cluster itself, or its parts with the
 *   representative's folder first
 */
export async function splitClusterByFolder(cluster, identify) {
  /** @type {Map<string, Group[]>} */
  const folders = new Map();
  for (const group of cluster.groups ?? []) {
    const key = folderOf(group);
    folders.set(key, [...(folders.get(key) ?? []), group]);
  }
  if (folders.size < 2) return [cluster];

  const rep = cluster.representative;
  const anchor = [...folders.keys()].find((key) =>
    folders.get(key)?.some((g) => g.items.includes(/** @type {EpisodeItem} */ (rep))),
  );
  if (anchor === undefined || !canSpeak(rep)) return [cluster];

  const anchorGroups = folders.get(anchor) ?? [];
  const anchorId = await identify(anchorGroups.flatMap((g) => g.items), rep);
  if (!isAnilistId(anchorId)) return [cluster];

  /** @type {Map<number, Group[]>} */
  const parts = new Map([[anchorId, []]]);
  for (const [key, groups] of folders) {
    let id = anchorId;
    if (key !== anchor) {
      const items = groups.flatMap((g) => g.items);
      const folderRep = pickRepresentative(items);
      const answer = canSpeak(folderRep) ? await identify(items, folderRep) : undefined;
      if (isAnilistId(answer)) id = /** @type {number} */ (answer);
    }
    parts.set(id, [...(parts.get(id) ?? []), ...groups]);
  }
  if (parts.size === 1) return [cluster];

  // Keep the cluster's group order inside each part.
  const order = new Map((cluster.groups ?? []).map((g, i) => [g, i]));
  return [...parts.values()].map((groups, index) =>
    clusterOfGroups(
      cluster,
      [...groups].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)),
      index,
    ),
  );
}

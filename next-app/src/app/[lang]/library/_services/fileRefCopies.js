// @ts-check
// Where a file the library already holds lives on disk.
//
// A fileRef's id is a hash of the file's bytes (recordFactory.fileRefId), so
// one row outlives a move, a rename, or a second copy turning up elsewhere.
// `relPath` + `libraryId` is where playback looks; `copies` lists the other
// places the same bytes were found while that path was still on disk.
//
// Before `copies` existed the row could name only one path, and a scan that
// found the other copy rewrote it — after which the next scan found the first
// copy, forever. Pure functions — no IDB, no DOM.

import { baselineKey, isGone, isOnDisk } from './rescanService.js';
import { fileRefId } from '@/lib/library/recordFactory.js';

/** @typedef {import('@/lib/library/types').FileRef} FileRef */
/** @typedef {import('@/lib/library/types').EpisodeItem} EpisodeItem */
/** @typedef {import('./rescanService.js').OnDisk} OnDisk */

/**
 * The row to write for bytes the library already holds (`prior`) now that
 * they were found at `found`'s location (libraryId + relPath).
 *
 *   - the recorded location is somewhere else and is known to still hold the
 *     file: this is a second copy. The row keeps the location playback
 *     already uses and lists this one.
 *   - otherwise (the same location, or the recorded one is gone or could not
 *     be read this pass): this location is the row's, with what the scan just
 *     read (libraryId, mtime, name-derived fields). A file that was certainly
 *     just found beats one that may or may not be there.
 *
 * Either way the row keeps its episode and match status — finding a file
 * again is no reason to re-match it — and listed copies known to be gone are
 * dropped. Copies under a folder that was not read are kept.
 *
 * @param {FileRef} prior
 * @param {FileRef} found  record built from the location just enumerated
 * @param {OnDisk} onDisk  what this pass found, per library
 * @returns {FileRef}
 */
export function relocateFileRef(prior, found, onDisk) {
  // Same bytes, so the same size wherever they are.
  const size = prior.size ?? 0;
  const others = (prior.copies ?? []).filter(
    (copy) =>
      !sameLocation(copy, found) &&
      !sameLocation(copy, prior) &&
      !isGone(onDisk, copy, size),
  );

  if (!sameLocation(found, prior) && isOnDisk(onDisk, prior, size)) {
    return withCopies(prior, [
      ...others,
      { libraryId: found.libraryId, relPath: found.relPath },
    ]);
  }

  return withCopies(
    {
      ...without(prior, 'supersededAt'),
      ...found,
      matchStatus: prior.matchStatus ?? found.matchStatus,
    },
    others,
  );
}

/**
 * Split items into the files to import and the extra copies among them:
 * items whose bytes already appeared earlier in the list. Only a content
 * hash proves two files hold the same bytes, so items without one (their
 * hashing failed) are always imported.
 *
 * @param {EpisodeItem[]} items
 * @returns {{ distinct: EpisodeItem[], copies: EpisodeItem[] }}
 */
export function separateCopies(items) {
  const seen = new Set();
  const distinct = [];
  const copies = [];
  for (const item of items) {
    if (!item.hash16M) {
      distinct.push(item);
      continue;
    }
    const id = fileRefId(item);
    if (seen.has(id)) {
      copies.push(item);
    } else {
      seen.add(id);
      distinct.push(item);
    }
  }
  return { distinct, copies };
}

/**
 * A cluster with each set of identical files in it reduced to its first
 * member. Two copies of the same bytes in one cluster would each mint an
 * Episode; the others are returned, to be listed as copies once the first has
 * a row. The copies leave their groups as well, and folders left
 * contributing nothing drop out, so a copy does not count as a second folder
 * merged into the card, and a cluster rebuilt from its groups (the folder
 * split) does not bring the copies back.
 *
 * @param {import('@/lib/library/types').MatchCluster} cluster
 * @returns {{ cluster: import('@/lib/library/types').MatchCluster, copies: EpisodeItem[] }}
 */
export function dropCopiesWithin(cluster) {
  const { distinct, copies } = separateCopies(cluster.items ?? []);
  if (!copies.length) return { cluster, copies };
  const kept = new Set(distinct);
  const rep = cluster.representative;
  const representative =
    rep && !kept.has(rep)
      ? (distinct.find((item) => item.hash16M && fileRefId(item) === fileRefId(rep)) ??
        distinct[0])
      : rep;
  return {
    cluster: {
      ...cluster,
      items: distinct,
      representative,
      groups: (cluster.groups ?? [])
        .map((group) => ({ ...group, items: (group.items ?? []).filter((item) => kept.has(item)) }))
        .filter((group) => group.items.length > 0),
    },
    copies,
  };
}

/**
 * What an import can be sure is on disk when its caller did not say: the
 * batch's own files, under the library it is importing into.
 *
 * @param {EpisodeItem[]} items
 * @param {string} libraryId
 * @returns {OnDisk}
 */
export function batchOnDisk(items, libraryId) {
  return new Map([
    [
      libraryId,
      new Set(items.map((item) => baselineKey(item.relativePath, item.file?.size ?? 0))),
    ],
  ]);
}

/**
 * @param {{ libraryId?: string, relPath: string }} a
 * @param {{ libraryId?: string, relPath: string }} b
 * @returns {boolean}
 */
function sameLocation(a, b) {
  return a.relPath === b.relPath && a.libraryId === b.libraryId;
}

/**
 * @param {FileRef} row
 * @param {Array<{ libraryId: string, relPath: string }>} copies
 * @returns {FileRef}
 */
function withCopies(row, copies) {
  const rest = without(row, 'copies');
  return copies.length ? { ...rest, copies } : rest;
}

/**
 * A copy of `row` without `key`.
 *
 * @param {FileRef} row
 * @param {keyof FileRef} key
 * @returns {FileRef}
 */
function without(row, key) {
  const copy = { ...row };
  delete copy[key];
  return copy;
}

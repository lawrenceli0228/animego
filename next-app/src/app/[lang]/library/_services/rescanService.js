// @ts-nocheck
// Incremental "reconciliation" scan for the watch-folder feature.
//
// Pure data layer — no React, no DOM. Read-only against the filesystem: this
// module NEVER calls requestPermission; callers guarantee the root handle has
// already been probed 'ready' (see rescanController).
//
//   enumerateAll(root) ──► diff vs (relPath,size) baseline ──► newVideos only
//
// The diff is what keeps rescans O(new files): only unseen entries proceed to
// the md5 hash phase and the dandanplay match downstream.

import { enumerate as enumerateTree } from "@/lib/library/enumerator.js";

/**
 * Files whose lastModified is younger than this are still considered "being
 * written" (torrent clients write final-named files in place) and are deferred
 * to the next scan. MUST be applied before the hash phase: BT writes out of
 * order, so hashing the first 16MB of a growing file produces a garbage id.
 */
export const QUIET_PERIOD_MS = 60_000;

/**
 * How far into the future an mtime may sit and still count as "being written".
 * Future mtimes have two real-world sources: (a) network mounts (SMB/NAS)
 * whose server clock runs a minute or two fast — an in-progress write there
 * carries a slightly-future mtime and must keep quiet-period protection; (b)
 * finished files that preserved a bogus timestamp (metadata written by the
 * download tool or a copy). Without this bound a future mtime makes
 * `now - mtime` negative — forever below QUIET_PERIOD_MS — so the file is
 * deferred on every scan and never enters the library. Beyond the skew we
 * assume (b) and import immediately; the pathological case (far-future clock
 * on a file still being written, hashed too early) self-heals: its size
 * changes once the write completes, and the superseded path re-imports the
 * relPath.
 */
export const FUTURE_SKEW_MS = 120_000;

/**
 * @param {string} relPath
 * @param {number} size
 * @returns {string}
 */
export function baselineKey(relPath, size) {
  return `${relPath}|${size}`;
}

// ---- what is on disk --------------------------------------------------------

/**
 * @typedef {Map<string, Set<string>>} OnDisk
 *   libraryId → baselineKey of every video found under that library's root in
 *   this pass. Records of one physical directory share a single set. A
 *   libraryId with no entry was not read this pass (not ready, removed,
 *   failed): whether its files are there is unknown.
 */

/**
 * @typedef {{ libraryId?: string, relPath: string }} FileLocation
 */

/**
 * The file is on disk at `location`: its root was read this pass and held it.
 *
 * @param {OnDisk|undefined} onDisk
 * @param {FileLocation} location
 * @param {number} size
 * @returns {boolean}
 */
export function isOnDisk(onDisk, location, size) {
  return Boolean(
    onDisk?.get(location.libraryId)?.has(baselineKey(location.relPath, size)),
  );
}

/**
 * The file is known NOT to be at `location`: its root was read this pass and
 * did not hold it. Unlike `!isOnDisk`, an unread root (unplugged, no grant)
 * says nothing either way.
 *
 * @param {OnDisk|undefined} onDisk
 * @param {FileLocation} location
 * @param {number} size
 * @returns {boolean}
 */
export function isGone(onDisk, location, size) {
  const seen = onDisk?.get(location.libraryId);
  return seen !== undefined && !seen.has(baselineKey(location.relPath, size));
}

// ---- baseline -----------------------------------------------------------------

/**
 * @typedef {{ id: string, libraryId: string, relPath: string, size: number }} RowRef
 *   Where a row says its bytes live: playback opens (libraryId, relPath).
 */

/**
 * @typedef {Object} Baseline
 * @property {Set<string>} keys  primary (relPath,size) key of every live row
 * @property {Map<string, any[]>} byRelPath  live rows grouped by primary relPath
 * @property {Set<string>} copyKeys  keys of the paths listed in rows' `copies`
 *   (a key that is also some row's primary counts as that primary)
 * @property {Map<string, RowRef>} rowOf  primary and copy keys → the row holding
 *   those bytes
 * @property {Set<string>} ids  id of every row, superseded ones included:
 *   the content the library has held, which is what separates a moved or
 *   copied file from a new episode once it lands
 */

/** @returns {RowRef} */
function rowRef(row) {
  return {
    id: row.id,
    libraryId: row.libraryId,
    relPath: row.relPath,
    size: row.size ?? 0,
  };
}

/**
 * Build the global diff baseline from every fileRef row in IDB.
 *
 * Global (not per-libraryId) by design: historical imports minted a fresh
 * libraryId per "+ add folder" click, so rows for the same physical directory
 * are scattered across many libraryIds. Keying on (relPath,size) alone makes
 * duplicate-root records harmless — the second enumeration of the same
 * directory finds zero new keys. Where the root does matter (a file whose
 * row belongs to another library folder), diffScanRoot reports it and the
 * controller decides with what is on disk.
 *
 * Rows tagged `supersededAt` (replaced by a same-relPath re-import) are
 * excluded so their stale (relPath,oldSize) keys don't shadow anything.
 *
 * fileRefs has no relPath index (schema v5) — full toArray is deliberate and
 * measured: hundreds of rows today, low-single-digit ms at 10k rows.
 *
 * @param {import('dexie').Dexie} db
 * @returns {Promise<Baseline>}
 */
export async function buildBaseline(db) {
  const rows = await db.fileRefs.toArray();
  const keys = new Set();
  const byRelPath = new Map();
  const copyKeys = new Set();
  const rowOf = new Map();
  const ids = new Set();
  const live = [];
  for (const row of rows) {
    if (row?.id) ids.add(row.id);
    if (!row?.relPath || row.supersededAt) continue;
    live.push(row);
    const key = baselineKey(row.relPath, row.size ?? 0);
    keys.add(key);
    if (!rowOf.has(key)) rowOf.set(key, rowRef(row));
    const group = byRelPath.get(row.relPath);
    if (group) group.push(row);
    else byRelPath.set(row.relPath, [row]);
  }
  // Copies second, so a path some row names as its primary always resolves
  // to that row. Same bytes means the same size: a copy's key differs from
  // its row's only in the path.
  for (const row of live) {
    for (const copy of row.copies ?? []) {
      if (!copy?.relPath) continue;
      const copyKey = baselineKey(copy.relPath, row.size ?? 0);
      if (keys.has(copyKey) || copyKeys.has(copyKey)) continue;
      copyKeys.add(copyKey);
      rowOf.set(copyKey, rowRef(row));
    }
  }
  return { keys, byRelPath, copyKeys, rowOf, ids };
}

// ---- diff ---------------------------------------------------------------------

/**
 * Enumerate one root and diff against the baseline.
 *
 * `libraryIds` are the libraries this directory is registered under (more
 * than one when the same folder was added twice). With them, a file at a path
 * the baseline knows is only skipped when a row of THIS folder names it; the
 * same path under another folder is reported as a foreign hit instead.
 * Without them every known path is skipped, as before.
 *
 * Selection rules:
 *   - video, key named by a row of this folder     → skipped (its recorded file)
 *   - video, inside quiet period                   → deferredCount (retry next scan);
 *     checked before anything that could lead to hashing
 *   - video, key named by a row of another folder  → foreignHits (the controller
 *     imports it to take over only once the row's own file is known gone)
 *   - video, key listed as a row's copy            → copyHits (the controller
 *     leaves it alone while the row's recorded file is on disk, and imports
 *     it to take over when it is not)
 *   - video, key unseen, outside quiet period      → newVideos
 *   - video, key unseen, same relPath known in
 *     this folder w/ different size                → newVideos + supersededCandidates
 *   - video, mtime more than FUTURE_SKEW_MS in
 *     the future                                   → treated as old (bad stored
 *     timestamp, not a live write — see FUTURE_SKEW_MS)
 *   - subtitle                                     → subtitles (sidecars never gate
 *     newness; playback resolves subs from the folder at play time, so a
 *     subtitle-only change needs no import)
 *
 * `seenKeys` holds the key of every video found, whatever its fate: it is
 * this folder's part of what is on disk now (see OnDisk).
 *
 * Throws on enumeration failure (unplugged volume, revoked permission) — the
 * controller isolates per root so one dead volume can't kill the whole pass.
 *
 * @param {{
 *   handle: FileSystemDirectoryHandle,
 *   baseline: Baseline,
 *   now: number,
 *   libraryIds?: Set<string>,
 *   enumerate?: (root: any) => AsyncIterable<{file: File, relPath: string, kind: string}>,
 * }} params
 * @returns {Promise<{
 *   newVideos: Array<{file: File, relPath: string, kind: 'video'}>,
 *   copyHits: Array<{entry: {file: File, relPath: string, kind: 'video'}, row: RowRef}>,
 *   foreignHits: Array<{entry: {file: File, relPath: string, kind: 'video'}, owners: RowRef[]}>,
 *   subtitles: Array<{file: File, relPath: string, kind: 'subtitle'}>,
 *   supersededCandidates: Array<{relPath: string, ids: string[]}>,
 *   deferredCount: number,
 *   seenRelPaths: Set<string>,
 *   seenKeys: Set<string>,
 * }>}
 */
export async function diffScanRoot({ handle, baseline, now, libraryIds, enumerate }) {
  const iterate = enumerate ?? enumerateTree;
  const ownRow = (row) => !libraryIds || libraryIds.has(row.libraryId);
  const newVideos = [];
  const copyHits = [];
  const foreignHits = [];
  const subtitles = [];
  const supersededCandidates = [];
  const seenRelPaths = new Set();
  const seenKeys = new Set();
  let deferredCount = 0;

  for await (const entry of iterate(handle)) {
    if (entry.kind === "subtitle") {
      subtitles.push(entry);
      continue;
    }
    if (entry.kind !== "video") continue;

    seenRelPaths.add(entry.relPath);

    const size = entry.file?.size ?? 0;
    const key = baselineKey(entry.relPath, size);
    seenKeys.add(key);

    const owners = baseline.keys.has(key)
      ? (baseline.byRelPath.get(entry.relPath) ?? []).filter(
          (row) => (row.size ?? 0) === size,
        )
      : [];
    if (owners.some(ownRow)) continue;

    const mtime = entry.file?.lastModified ?? 0;
    const age = now - mtime; // negative when the mtime sits in the future
    if (mtime > 0 && age < QUIET_PERIOD_MS && age > -FUTURE_SKEW_MS) {
      deferredCount++;
      continue;
    }

    if (owners.length) {
      foreignHits.push({ entry, owners: owners.map(rowRef) });
      continue;
    }
    if (baseline.copyKeys?.has(key)) {
      copyHits.push({ entry, row: baseline.rowOf.get(key) });
      continue;
    }

    const oldRows = (baseline.byRelPath.get(entry.relPath) ?? []).filter(ownRow);
    if (oldRows.length) {
      supersededCandidates.push({
        relPath: entry.relPath,
        ids: oldRows.map((r) => r.id),
      });
    }

    newVideos.push(entry);
  }

  return {
    newVideos,
    copyHits,
    foreignHits,
    subtitles,
    supersededCandidates,
    deferredCount,
    seenRelPaths,
    seenKeys,
  };
}

/**
 * Tag replaced fileRef rows so future baselines ignore them. Tagging (not
 * deleting) keeps Episode.primaryFileId references valid — playback resolves
 * by relPath, which now serves the replacement content anyway.
 *
 * Candidates were picked when the pass began. A row another folder's import
 * has since moved (a copy taking over) is no longer at that path, so each row
 * is re-read and only tagged if it still sits at the candidate path in one of
 * `libraryIds` (the scanned folder's libraries; any library when omitted).
 *
 * @param {import('dexie').Dexie} db
 * @param {Array<{relPath: string, ids: string[]}>} candidates
 * @param {number} now
 * @param {Set<string>} [libraryIds]
 * @returns {Promise<void>}
 */
export async function markSuperseded(db, candidates, now, libraryIds) {
  for (const candidate of candidates) {
    for (const id of candidate.ids) {
      const row = await db.fileRefs.get(id);
      if (!row || row.relPath !== candidate.relPath) continue;
      if (libraryIds && !libraryIds.has(row.libraryId)) continue;
      await db.fileRefs.update(id, { supersededAt: now });
    }
  }
}

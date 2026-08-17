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

/**
 * Build the global diff baseline from every fileRef row in IDB.
 *
 * Global (not per-libraryId) by design: historical imports minted a fresh
 * libraryId per "+ add folder" click, so rows for the same physical directory
 * are scattered across many libraryIds. Keying on (relPath,size) alone makes
 * duplicate-root records harmless — the second enumeration of the same
 * directory finds zero new keys.
 *
 * Rows tagged `supersededAt` (replaced by a same-relPath re-import) are
 * excluded so their stale (relPath,oldSize) keys don't shadow anything.
 *
 * fileRefs has no relPath index (schema v5) — full toArray is deliberate and
 * measured: hundreds of rows today, low-single-digit ms at 10k rows.
 *
 * @param {import('dexie').Dexie} db
 * @returns {Promise<{ keys: Set<string>, byRelPath: Map<string, any[]> }>}
 */
export async function buildBaseline(db) {
  const rows = await db.fileRefs.toArray();
  const keys = new Set();
  const byRelPath = new Map();
  for (const row of rows) {
    if (!row?.relPath || row.supersededAt) continue;
    keys.add(baselineKey(row.relPath, row.size ?? 0));
    const group = byRelPath.get(row.relPath);
    if (group) group.push(row);
    else byRelPath.set(row.relPath, [row]);
  }
  return { keys, byRelPath };
}

/**
 * Enumerate one root and diff against the baseline.
 *
 * Selection rules:
 *   - video, key unseen, outside quiet period      → newVideos
 *   - video, key unseen, same relPath known w/
 *     different size                               → newVideos + supersededCandidates
 *   - video, inside quiet period                   → deferredCount (retry next scan)
 *   - video, mtime more than FUTURE_SKEW_MS in
 *     the future                                   → newVideos (bad stored timestamp,
 *     not a live write — see FUTURE_SKEW_MS)
 *   - video, key already in baseline               → skipped
 *   - subtitle                                     → subtitles (sidecars never gate
 *     newness; playback resolves subs from the folder at play time, so a
 *     subtitle-only change needs no import)
 *
 * Throws on enumeration failure (unplugged volume, revoked permission) — the
 * controller isolates per root so one dead volume can't kill the whole pass.
 *
 * @param {{
 *   handle: FileSystemDirectoryHandle,
 *   baseline: { keys: Set<string>, byRelPath: Map<string, any[]> },
 *   now: number,
 *   enumerate?: (root: any) => AsyncIterable<{file: File, relPath: string, kind: string}>,
 * }} params
 * @returns {Promise<{
 *   newVideos: Array<{file: File, relPath: string, kind: 'video'}>,
 *   subtitles: Array<{file: File, relPath: string, kind: 'subtitle'}>,
 *   supersededCandidates: Array<{relPath: string, ids: string[]}>,
 *   deferredCount: number,
 *   seenRelPaths: Set<string>,
 * }>}
 */
export async function diffScanRoot({ handle, baseline, now, enumerate }) {
  const iterate = enumerate ?? enumerateTree;
  const newVideos = [];
  const subtitles = [];
  const supersededCandidates = [];
  const seenRelPaths = new Set();
  let deferredCount = 0;

  for await (const entry of iterate(handle)) {
    if (entry.kind === "subtitle") {
      subtitles.push(entry);
      continue;
    }
    if (entry.kind !== "video") continue;

    seenRelPaths.add(entry.relPath);

    const size = entry.file?.size ?? 0;
    if (baseline.keys.has(baselineKey(entry.relPath, size))) continue;

    const mtime = entry.file?.lastModified ?? 0;
    const age = now - mtime; // negative when the mtime sits in the future
    if (mtime > 0 && age < QUIET_PERIOD_MS && age > -FUTURE_SKEW_MS) {
      deferredCount++;
      continue;
    }

    const oldRows = baseline.byRelPath.get(entry.relPath);
    if (oldRows?.length) {
      supersededCandidates.push({
        relPath: entry.relPath,
        ids: oldRows.map((r) => r.id),
      });
    }

    newVideos.push(entry);
  }

  return { newVideos, subtitles, supersededCandidates, deferredCount, seenRelPaths };
}

/**
 * Tag replaced fileRef rows so future baselines ignore them. Tagging (not
 * deleting) keeps Episode.primaryFileId references valid — playback resolves
 * by relPath, which now serves the replacement content anyway.
 *
 * @param {import('dexie').Dexie} db
 * @param {Array<{relPath: string, ids: string[]}>} candidates
 * @param {number} now
 * @returns {Promise<void>}
 */
export async function markSuperseded(db, candidates, now) {
  for (const candidate of candidates) {
    for (const id of candidate.ids) {
      await db.fileRefs.update(id, { supersededAt: now });
    }
  }
}

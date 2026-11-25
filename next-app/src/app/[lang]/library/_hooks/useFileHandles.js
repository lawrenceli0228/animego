"use client";
// @ts-nocheck
import { useState, useEffect, useCallback, useRef } from 'react';
import * as Sentry from '@sentry/nextjs';
import toast from 'react-hot-toast';
import { useLang } from '@/lib/lang-client';
import { isFsaSupported } from '@/lib/library/handles/fsaFeatureCheck.js';
import { ensurePermission } from '@/lib/library/handles/permissionGate.js';
import { makeFileHandleStore } from '@/lib/library/handles/fileHandleStore.js';
import { probeRootStatus } from '@/lib/library/handles/probeRoot.js';
import { repickRoot, VERIFY_SAMPLE_SIZE } from '@/lib/library/handles/repickRoot.js';
import { pickLargestSameExt } from '@/lib/library/enumerator.js';
import { listSubtitlesNear as listNear } from '@/lib/subtitles/listNearby';


/**
 * The picker rejects with AbortError when the user dismisses it. Every browser
 * that implements showDirectoryPicker uses that name, so this is a decision
 * signal rather than a fault and must never reach Sentry — it would be by far
 * the most common "error" the library surface produces.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isAbortError(err) {
  return Boolean(err) && typeof err === 'object' && err.name === 'AbortError';
}

// A stale handle is a browser fault, not something the user did, and it
// recurs on every page load until the folder is picked again. One report per
// page load is enough to count how many libraries are affected.
let staleReported = false;

/** @typedef {import('@/lib/library/types').HandleRecord} HandleRecord */
/** @typedef {import('@/lib/library/handles/probeRoot.js').RootStatus} RootStatus */

/**
 * @typedef {'unsupported'|'idle'|'loading'|'ready'|'denied'} HandleStatus
 */

/**
 * React hook that manages persisted FileSystemDirectoryHandle records.
 *
 * On mount: if FSA is supported, loads all persisted handles and probes each
 * one (read-only — never prompts for permission). Per-library status is
 * exposed via `libraryStatus` so the UI can distinguish 'disconnected'
 * (drive unplugged) from 'denied' (permission lost) and 'stale' (a stored
 * handle the browser no longer answers for — only picking the folder again
 * recovers it, which `reauthorize` does for such a library).
 *
 * @param {{ db: import('dexie').Dexie }} options
 * @returns {{
 *   status: HandleStatus,
 *   roots: HandleRecord[],
 *   libraryStatus: Map<string, RootStatus>,
 *   pickFolder(libraryId: string): Promise<HandleRecord|null>,
 *   reauthorize(libraryId: string): Promise<import('@/lib/library/handles/repickRoot.js').RepickResult|void>,
 *   dropFolder(id: string): Promise<void>,
 *   selectFileByName(libraryId: string, relPath: string): Promise<File|null>,
 *   listSubtitlesNear(libraryId: string, relPath: string): Promise<{ file: File, relPath: string }[]>,
 *   refresh(): Promise<void>,
 * }}
 */
export function useFileHandles({ db }) {
  const storeRef = useRef(/** @type {ReturnType<typeof makeFileHandleStore>|null} */ (null));

  /** @type {[HandleStatus, React.Dispatch<React.SetStateAction<HandleStatus>>]} */
  const [status, setStatus] = useState('idle');
  const [roots, setRoots] = useState(/** @type {HandleRecord[]} */ ([]));
  const [libraryStatus, setLibraryStatus] = useState(
    /** @type {Map<string, RootStatus>} */ (new Map()),
  );
  // reauthorize reads this synchronously: the picker must open before any
  // await, and it only opens for a library whose last probe came back stale.
  const libraryStatusRef = useRef(/** @type {Map<string, RootStatus>} */ (new Map()));
  // The folder name shown when asking the user to pick it again.
  const rootsRef = useRef(/** @type {HandleRecord[]} */ ([]));
  // A stale root keeps a probe pending for PERMISSION_QUERY_TIMEOUT_MS, so
  // refreshes overlap (mount, post-scan, a re-pick's own refresh). Only the
  // latest one may write, or an older probe of the replaced handle lands
  // after the re-pick and marks the library stale again.
  const refreshGenRef = useRef(0);
  const { t } = useLang();

  // Lazily initialise the store once per db instance
  function getStore() {
    if (!storeRef.current) {
      storeRef.current = makeFileHandleStore(db);
    }
    return storeRef.current;
  }

  /** Reload roots from IDB and re-classify each via a read-only probe. */
  const refresh = useCallback(async () => {
    const gen = ++refreshGenRef.current;
    const store = getStore();
    const allRoots = await store.listRoots();

    // Probe in parallel — each handle is independent and probeRootStatus is
    // read-only (no requestPermission), so no user-gesture sequencing needed.
    const probes = await Promise.all(
      allRoots.map(async (rec) => /** @type {[string, RootStatus]} */ ([
        rec.libraryId,
        await probeRootStatus(rec.handle),
      ])),
    );
    if (gen !== refreshGenRef.current) return;
    const newStatus = new Map(probes);

    let anyDenied = false;
    let staleCount = 0;
    for (const [, st] of newStatus) {
      if (st === 'denied') anyDenied = true;
      if (st === 'stale') staleCount += 1;
    }
    if (staleCount > 0 && !staleReported) {
      staleReported = true;
      Sentry.captureMessage('library: stored folder handle never answered queryPermission', {
        level: 'warning',
        extra: { staleCount, rootCount: allRoots.length },
      });
    }

    libraryStatusRef.current = newStatus;
    rootsRef.current = allRoots;
    setRoots(allRoots);
    setLibraryStatus(newStatus);
    // Global status keeps its old contract: 'denied' when any handle is denied,
    // otherwise 'ready'. Disconnected and stale roots don't flip the global
    // flag — the per-library `libraryStatus` map is the surface for those.
    // The player hides a series' episodes behind a global 'denied', and a
    // stale library must not do that to a healthy one; playing from a stale
    // library flips it through selectFileByName instead.
    setStatus(anyDenied ? 'denied' : 'ready');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db]);

  useEffect(() => {
    if (!isFsaSupported()) {
      setStatus('unsupported');
      return;
    }
    setStatus('loading');
    refresh().catch(() => setStatus('ready'));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Open a directory picker and persist the chosen handle.
   * MUST be called from a user gesture.
   *
   * @param {string} libraryId
   * @returns {Promise<HandleRecord|null>}
   */
  const pickFolder = useCallback(async (libraryId) => {
    try {
      // P6 verify: gesture-bound. showDirectoryPicker() requires transient
      // activation; Chrome drops the click grant ~5 s after the user gesture
      // so this MUST stay reachable from an onClick path with no intervening
      // useEffect. Callers should invoke `pickFolder` directly from a button
      // handler, never via setTimeout, queueMicrotask, or after an `await`.
      const handle = await window.showDirectoryPicker();
      const store = getStore();
      const record = await store.saveRoot(handle, libraryId);
      await refresh();
      return record;
    } catch (err) {
      // Dismissing the picker rejects with AbortError. That is a decision,
      // not a fault, and reporting it would bury the real failures under it.
      //
      // Everything else gets reported. This was a bare `catch` returning
      // null, which meant a browser that could not write to IndexedDB at all
      // — a locked or read-only profile, a full disk — presented as a folder
      // picker that simply did nothing when you chose a folder, with no trace
      // in Sentry and nothing for the user to act on.
      if (!isAbortError(err)) Sentry.captureException(err);
      return null;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  /**
   * Re-request permission for the handle associated with libraryId, or — when
   * its last probe came back stale — open the picker and swap in the folder
   * the user picks, if it is the same folder (see lib/library/handles/repickRoot).
   * @param {string} libraryId
   * @returns {Promise<import('@/lib/library/handles/repickRoot.js').RepickResult|void>}
   */
  const reauthorize = useCallback(async (libraryId) => {
    const store = getStore();
    if (libraryStatusRef.current.get(libraryId) === 'stale') {
      // requestPermission on a stale handle hangs like queryPermission does,
      // so the only way back is picking the folder again. repickRoot opens
      // the picker before its first await, inside this click's activation.
      const name = rootsRef.current.find((r) => r.libraryId === libraryId)?.name ?? '';
      const result = await repickRoot({
        libraryId,
        pick: () => {
          // The picker has no title of its own; say which folder to pick.
          toast(t('library.repickPrompt').replace('{{name}}', name));
          return window.showDirectoryPicker();
        },
        findByLibrary: (id) => store.findByLibrary(id),
        // Newest rows first (ULID ids sort by import time), skipping rows a
        // re-import replaced: old episodes are the ones deleted after watching.
        sampleRelPaths: async (id) => {
          const refs = await db.fileRefs
            .reverse()
            .filter((r) => r.libraryId === id && !r.supersededAt && typeof r.relPath === 'string')
            .limit(VERIFY_SAMPLE_SIZE)
            .toArray();
          return refs.map((r) => r.relPath);
        },
        saveRoot: (handle, id) => store.saveRoot(handle, id),
      });
      if (result.status === 'mismatch') {
        toast.error(t('library.repickMismatch').replace('{{name}}', name));
      }
      await refresh();
      return result;
    }
    const rec = await store.findByLibrary(libraryId);
    if (!rec) return;
    // P6 verify: gesture-bound. ensurePermission() calls handle.requestPermission()
    // which (like showDirectoryPicker) requires transient activation. Callers
    // must invoke reauthorize from an onClick handler with no preceding await
    // chain, or the prompt will silently no-op.
    await ensurePermission(rec.handle);
    await refresh();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, db, t]);

  /**
   * Delete a persisted handle record by id.
   * @param {string} id
   * @returns {Promise<void>}
   */
  const dropFolder = useCallback(async (id) => {
    const store = getStore();
    await store.dropRoot(id);
    await refresh();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  /**
   * Walk the root handle for libraryId by path segments and return the File.
   * Returns null on any miss, permission denial, or handle not found.
   *
   * @param {string} libraryId
   * @param {string} relPath  - path relative to root, e.g. "Season1/ep01.mkv"
   * @returns {Promise<File|null>}
   */
  const selectFileByName = useCallback(async (libraryId, relPath) => {
    const store = getStore();
    const rec = await store.findByLibrary(libraryId);
    if (!rec) return null;

    try {
      // P6 verify: gesture-bound. ensurePermission triggers requestPermission
      // on first call after a stale grant — selectFileByName should be reached
      // from an onClick (e.g. play button) and not from a useEffect chain.
      const perm = await ensurePermission(rec.handle);
      if (perm === 'stale') {
        // Mark it so the reauthorize CTA this denial surfaces re-picks the
        // folder instead of requesting permission on a handle that hangs.
        const next = new Map(libraryStatusRef.current);
        next.set(libraryId, 'stale');
        libraryStatusRef.current = next;
        setLibraryStatus(next);
      }
      if (perm !== 'granted') {
        setStatus('denied');
        return null;
      }

      const segments = relPath.split('/').filter(Boolean);
      // Reject path traversal: '..' segments could escape the picked root if a
      // browser's FSA implementation doesn't clamp them. Spec is implementation-defined.
      if (segments.some(seg => seg === '..' || seg === '.')) return null;
      const fileName = segments.pop();
      if (!fileName) return null;

      /** @type {any} */
      let current = rec.handle;
      for (const seg of segments) {
        current = await current.getDirectoryHandle(seg);
      }
      try {
        const fileHandle = await current.getFileHandle(fileName);
        return await fileHandle.getFile();
      } catch (err) {
        // macOS ExFAT `.mp4` directory bundle: relPath points at a directory
        // whose name carries a video extension. The enumerator drills into it
        // at import time (picking the largest same-ext child); mirror that
        // drill here so playback can resolve the same File.
        if (err?.name === 'TypeMismatchError') {
          const dirHandle = await current.getDirectoryHandle(fileName);
          const picked = await pickLargestSameExt(dirHandle);
          return picked?.file ?? null;
        }
        throw err;
      }
    } catch (err) {
      if (err && err.name === 'NotAllowedError') {
        setStatus('denied');
      }
      return null;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Subtitle files in the folder `relPath` sits in, and in the folders
   * directly inside it (`Subs/`, `SC/`, `字幕/`), for the player to match
   * against the video at play time.
   *
   * The library import walks subtitles but never stores them — rescanService
   * says playback resolves them "from the folder at play time" — and until
   * this existed, nothing did: a library episode played with no sidecar ever.
   *
   * Reached right after selectFileByName for the same video, so the root's
   * permission is already granted. Returns [] on any failure — a folder that
   * cannot be listed leaves the video playable. See lib/subtitles/listNearby.
   */
  const listSubtitlesNear = useCallback(async (libraryId, relPath) => {
    try {
      const rec = await getStore().findByLibrary(libraryId);
      if (!rec) return [];
      return await listNear(rec.handle, relPath);
    } catch {
      return [];
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { status, roots, libraryStatus, pickFolder, reauthorize, dropFolder, selectFileByName, listSubtitlesNear, refresh };
}

export default useFileHandles;

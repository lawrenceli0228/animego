// @ts-check
import { useState, useEffect, useCallback, useRef } from 'react';
import { isFsaSupported } from '../lib/library/handles/fsaFeatureCheck.js';
import { ensurePermission } from '../lib/library/handles/permissionGate.js';
import { makeFileHandleStore } from '../lib/library/handles/fileHandleStore.js';
import { probeRootStatus } from '../lib/library/handles/probeRoot.js';
import { pickLargestSameExt } from '../lib/library/enumerator.js';

/** @typedef {import('../lib/library/types').HandleRecord} HandleRecord */
/** @typedef {import('../lib/library/handles/probeRoot.js').RootStatus} RootStatus */

/**
 * @typedef {'unsupported'|'idle'|'loading'|'ready'|'denied'} HandleStatus
 */

/**
 * React hook that manages persisted FileSystemDirectoryHandle records.
 *
 * On mount: if FSA is supported, loads all persisted handles and probes each
 * one (read-only — never prompts for permission). Per-library status is
 * exposed via `libraryStatus` so the UI can distinguish 'disconnected'
 * (drive unplugged) from 'denied' (permission lost).
 *
 * @param {{ db: import('dexie').Dexie }} options
 * @returns {{
 *   status: HandleStatus,
 *   roots: HandleRecord[],
 *   libraryStatus: Map<string, RootStatus>,
 *   pickFolder(libraryId: string): Promise<HandleRecord|null>,
 *   reauthorize(libraryId: string): Promise<void>,
 *   dropFolder(id: string): Promise<void>,
 *   selectFileByName(libraryId: string, relPath: string): Promise<File|null>,
 *   refresh(): Promise<void>,
 * }}
 */
export default function useFileHandles({ db }) {
  const storeRef = useRef(/** @type {ReturnType<typeof makeFileHandleStore>|null} */ (null));

  /** @type {[HandleStatus, React.Dispatch<React.SetStateAction<HandleStatus>>]} */
  const [status, setStatus] = useState('idle');
  const [roots, setRoots] = useState(/** @type {HandleRecord[]} */ ([]));
  const [libraryStatus, setLibraryStatus] = useState(
    /** @type {Map<string, RootStatus>} */ (new Map()),
  );

  // Lazily initialise the store once per db instance
  function getStore() {
    if (!storeRef.current) {
      storeRef.current = makeFileHandleStore(db);
    }
    return storeRef.current;
  }

  /** Reload roots from IDB and re-classify each via a read-only probe. */
  const refresh = useCallback(async () => {
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
    const newStatus = new Map(probes);

    let anyDenied = false;
    for (const [, st] of newStatus) {
      if (st === 'denied') anyDenied = true;
    }

    setRoots(allRoots);
    setLibraryStatus(newStatus);
    // Global status keeps its old contract: 'denied' when any handle is denied,
    // otherwise 'ready'. Disconnected drives don't flip the global flag — the
    // per-library `libraryStatus` map is the surface for that signal.
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
      const handle = await window.showDirectoryPicker();
      const store = getStore();
      const record = await store.saveRoot(handle, libraryId);
      await refresh();
      return record;
    } catch {
      return null;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  /**
   * Re-request permission for the handle associated with libraryId.
   * @param {string} libraryId
   * @returns {Promise<void>}
   */
  const reauthorize = useCallback(async (libraryId) => {
    const store = getStore();
    const rec = await store.findByLibrary(libraryId);
    if (!rec) return;
    await ensurePermission(rec.handle);
    await refresh();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

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
      const perm = await ensurePermission(rec.handle);
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

  return { status, roots, libraryStatus, pickFolder, reauthorize, dropFolder, selectFileByName, refresh };
}

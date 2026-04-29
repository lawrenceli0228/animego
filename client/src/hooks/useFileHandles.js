// @ts-check
import { useState, useEffect, useCallback, useRef } from 'react';
import { isFsaSupported } from '../lib/library/handles/fsaFeatureCheck.js';
import { ensurePermission } from '../lib/library/handles/permissionGate.js';
import { makeFileHandleStore } from '../lib/library/handles/fileHandleStore.js';

/** @typedef {import('../lib/library/types').HandleRecord} HandleRecord */

/**
 * @typedef {'unsupported'|'idle'|'loading'|'ready'|'denied'} HandleStatus
 */

/**
 * React hook that manages persisted FileSystemDirectoryHandle records.
 *
 * On mount: if FSA is supported, loads all persisted handles and re-checks
 * permissions. Otherwise status is set to 'unsupported'.
 *
 * @param {{ db: import('dexie').Dexie }} options
 * @returns {{
 *   status: HandleStatus,
 *   roots: HandleRecord[],
 *   pickFolder(libraryId: string): Promise<HandleRecord|null>,
 *   reauthorize(libraryId: string): Promise<void>,
 *   dropFolder(id: string): Promise<void>,
 *   selectFileByName(libraryId: string, relPath: string): Promise<File|null>,
 * }}
 */
export default function useFileHandles({ db }) {
  const storeRef = useRef(/** @type {ReturnType<typeof makeFileHandleStore>|null} */ (null));

  /** @type {[HandleStatus, React.Dispatch<React.SetStateAction<HandleStatus>>]} */
  const [status, setStatus] = useState('idle');
  const [roots, setRoots] = useState(/** @type {HandleRecord[]} */ ([]));

  // Lazily initialise the store once per db instance
  function getStore() {
    if (!storeRef.current) {
      storeRef.current = makeFileHandleStore(db);
    }
    return storeRef.current;
  }

  /** Reload roots from IDB and re-verify permissions */
  const refresh = useCallback(async () => {
    const store = getStore();
    const allRoots = await store.listRoots();
    let anyDenied = false;

    for (const rec of allRoots) {
      const perm = await ensurePermission(rec.handle);
      if (perm === 'denied') anyDenied = true;
    }

    setRoots(allRoots);
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
      const fileName = segments.pop();
      if (!fileName) return null;

      /** @type {any} */
      let current = rec.handle;
      for (const seg of segments) {
        current = await current.getDirectoryHandle(seg);
      }
      const fileHandle = await current.getFileHandle(fileName);
      return await fileHandle.getFile();
    } catch (err) {
      if (err && err.name === 'NotAllowedError') {
        setStatus('denied');
      }
      return null;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { status, roots, pickFolder, reauthorize, dropFolder, selectFileByName };
}

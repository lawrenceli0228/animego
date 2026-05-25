// @ts-check
// Repository factory for persisting FileSystemDirectoryHandle records in IDB.
//
// Production: FileSystemDirectoryHandle serializes natively via structuredClone.
// Tests: fake handles have function properties that structuredClone rejects.
//   Fallback: store a serializable stub in IDB; keep the live handle in a
//   module-level Map keyed by record id so same-session reads return the real
//   object.

/** @typedef {import('../types').HandleRecord} HandleRecord */

import { ulid } from '../ulid.js';

/** Live handle cache for environments where IDB cannot clone the handle. */
const _handleCache = new Map();

/**
 * Create a fileHandle store repo bound to the given Dexie instance.
 *
 * @param {import('dexie').Dexie} db
 * @returns {{
 *   saveRoot(handle: FileSystemDirectoryHandle, libraryId: string): Promise<HandleRecord>,
 *   listRoots(): Promise<HandleRecord[]>,
 *   dropRoot(id: string): Promise<void>,
 *   findByLibrary(libraryId: string): Promise<HandleRecord|null>,
 * }}
 */
export function makeFileHandleStore(db) {
  /**
   * Attempt to persist a row. If structuredClone rejects the handle, store a
   * plain stub instead and keep the live reference in _handleCache.
   *
   * @param {{ id: string, libraryId: string, name: string, addedAt: number, lastSeenAt: number }} base
   * @param {FileSystemDirectoryHandle} handle
   * @returns {Promise<HandleRecord>}
   */
  async function persist(base, handle) {
    // Cache the live handle by id (covers both production and test paths)
    _handleCache.set(base.id, handle);

    try {
      const row = { ...base, handle };
      await db.fileHandles.put(row);
      return /** @type {HandleRecord} */ ({ ...row });
    } catch {
      // DataCloneError: store a serializable stub
      const row = { ...base, handle: { __stub: true, name: handle.name } };
      await db.fileHandles.put(row);
      return /** @type {HandleRecord} */ ({ ...row, handle });
    }
  }

  /**
   * Restore the live handle for a row fetched from IDB (covers stub path).
   * @param {any} row
   * @returns {HandleRecord}
   */
  function hydrate(row) {
    if (!row) return row;
    const live = _handleCache.get(row.id);
    if (live) return { ...row, handle: live };
    return row;
  }

  /**
   * Persist a root directory handle.
   * Idempotent: if a record with the same libraryId already exists,
   * update lastSeenAt and the handle instead of inserting a duplicate.
   *
   * @param {FileSystemDirectoryHandle} handle
   * @param {string} libraryId
   * @returns {Promise<HandleRecord>}
   */
  async function saveRoot(handle, libraryId) {
    const existing = await db.fileHandles.where('libraryId').equals(libraryId).first();
    const now = Date.now();

    if (existing) {
      const base = {
        id: existing.id,
        libraryId,
        name: handle.name,
        addedAt: existing.addedAt ?? now,
        lastSeenAt: now,
      };
      return persist(base, handle);
    }

    const base = { id: ulid(), libraryId, name: handle.name, addedAt: now, lastSeenAt: now };
    return persist(base, handle);
  }

  /**
   * List all persisted root handles.
   * @returns {Promise<HandleRecord[]>}
   */
  async function listRoots() {
    const rows = await db.fileHandles.toArray();
    return rows.map(hydrate);
  }

  /**
   * Remove a persisted root handle record by id.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async function dropRoot(id) {
    _handleCache.delete(id);
    await db.fileHandles.delete(id);
  }

  /**
   * Find the handle record for a given library, or null if none exists.
   * @param {string} libraryId
   * @returns {Promise<HandleRecord|null>}
   */
  async function findByLibrary(libraryId) {
    const rec = await db.fileHandles.where('libraryId').equals(libraryId).first();
    if (!rec) return null;
    return hydrate(rec);
  }

  return { saveRoot, listRoots, dropRoot, findByLibrary };
}

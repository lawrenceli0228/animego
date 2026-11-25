// @ts-nocheck

import { PERMISSION_QUERY_TIMEOUT_MS, isTimedOut, settleWithin } from './probeRoot.js';

/**
 * Ensure read (or readwrite) permission on a FileSystemDirectoryHandle.
 *
 * - If already granted: returns 'granted' immediately.
 * - If 'prompt': calls requestPermission and returns its result.
 * - If queryPermission never answers: returns 'stale' without prompting.
 *   That handle is unusable (see probeRoot.js), and requestPermission on it
 *   would hang the same way while holding the click's activation.
 * - If 'denied' or any throw: returns 'denied' (never re-throws).
 *
 * @param {FileSystemDirectoryHandle} handle
 * @param {'read'|'readwrite'} [mode='read']
 * @param {{ permissionTimeoutMs?: number }} [opts]
 * @returns {Promise<'granted'|'denied'|'stale'>}
 */
export async function ensurePermission(handle, mode = 'read', opts = {}) {
  const { permissionTimeoutMs = PERMISSION_QUERY_TIMEOUT_MS } = opts;
  try {
    const current = await settleWithin(handle.queryPermission({ mode }), permissionTimeoutMs);
    if (isTimedOut(current)) return 'stale';
    if (current === 'granted') return 'granted';
    if (current === 'denied') return 'denied';
    // 'prompt' — ask the user
    const requested = await handle.requestPermission({ mode });
    return requested === 'granted' ? 'granted' : 'denied';
  } catch {
    return 'denied';
  }
}

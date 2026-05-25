// @ts-check

/**
 * Ensure read (or readwrite) permission on a FileSystemDirectoryHandle.
 *
 * - If already granted: returns 'granted' immediately.
 * - If 'prompt': calls requestPermission and returns its result.
 * - If 'denied' or any throw: returns 'denied' (never re-throws).
 *
 * @param {FileSystemDirectoryHandle} handle
 * @param {'read'|'readwrite'} [mode='read']
 * @returns {Promise<'granted'|'denied'>}
 */
export async function ensurePermission(handle, mode = 'read') {
  try {
    const current = await handle.queryPermission({ mode });
    if (current === 'granted') return 'granted';
    if (current === 'denied') return 'denied';
    // 'prompt' — ask the user
    const requested = await handle.requestPermission({ mode });
    return requested === 'granted' ? 'granted' : 'denied';
  } catch {
    return 'denied';
  }
}

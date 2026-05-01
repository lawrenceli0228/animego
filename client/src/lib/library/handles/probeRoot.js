// @ts-check
// Probe a persisted root handle without prompting for permission.
// Distinguishes 'disconnected' (drive unplugged) from 'denied' (permission lost).

/** @typedef {'ready'|'denied'|'disconnected'|'error'} RootStatus */

/**
 * Classify a root handle's current accessibility.
 *
 * Read-only probe — never calls `requestPermission`, so this is safe to fire
 * from `useEffect` on mount where there is no user gesture.
 *
 * - 'ready'        — permission granted AND a filesystem read returns
 * - 'denied'       — permission state is 'denied' or 'prompt' (we can't prompt without a gesture)
 * - 'disconnected' — permission granted but the volume is gone (USB unplugged,
 *                    network share dropped) — manifests as NotFoundError /
 *                    NotReadableError on the iterator
 * - 'error'        — any other failure
 *
 * @param {FileSystemDirectoryHandle | null | undefined} handle
 * @returns {Promise<RootStatus>}
 */
export async function probeRootStatus(handle) {
  if (!handle || typeof handle !== 'object') return 'error';

  try {
    if (typeof handle.queryPermission === 'function') {
      const perm = await handle.queryPermission({ mode: 'read' });
      if (perm === 'denied') return 'denied';
      // 'prompt' state can't be resolved without a user gesture; classify as
      // denied so the UI shows the same reauthorize CTA. The user-gesture path
      // (selectFileByName) will attempt requestPermission on its own.
      if (perm !== 'granted') return 'denied';
    }

    // Touch the filesystem so a disconnected volume fails fast. Opening the
    // entries iterator and asking for one item is enough — empty directories
    // still resolve with `{done:true}`, but unmounted volumes reject.
    if (typeof handle.entries === 'function') {
      const iterator = handle.entries();
      await iterator.next();
    }
    return 'ready';
  } catch (err) {
    const name = /** @type {any} */ (err)?.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
    if (name === 'NotFoundError' || name === 'NotReadableError' || name === 'AbortError') {
      return 'disconnected';
    }
    return 'error';
  }
}

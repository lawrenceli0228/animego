// @ts-nocheck
// Probe a persisted root handle without prompting for permission.
// Distinguishes 'disconnected' (drive unplugged) from 'denied' (permission lost).

/** @typedef {'ready'|'denied'|'stale'|'disconnected'|'error'} RootStatus */

// queryPermission is answered from the browser's own permission state and
// does not touch the disk, so it settles in milliseconds. A handle saved by
// an older Chrome can come back from IndexedDB in a state where Chrome 158
// never settles it at all; past this bound the handle is treated as stale.
export const PERMISSION_QUERY_TIMEOUT_MS = 3_000;

// The first read does touch the disk, and a sleeping drive can take seconds
// to spin up, so it gets a longer bound before the volume counts as gone.
export const ROOT_READ_TIMEOUT_MS = 10_000;

const TIMED_OUT = Symbol('timed out');

/**
 * Settle with the promise's value, or TIMED_OUT once `ms` passes first.
 * Rejections pass through.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T | typeof TIMED_OUT>}
 */
export function settleWithin(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function isTimedOut(value) {
  return value === TIMED_OUT;
}

/**
 * Classify a root handle's current accessibility.
 *
 * Read-only probe — never calls `requestPermission`, so this is safe to fire
 * from `useEffect` on mount where there is no user gesture.
 *
 * - 'ready'        — permission granted AND a filesystem read returns
 * - 'denied'       — permission state is 'denied' or 'prompt' (we can't prompt without a gesture)
 * - 'stale'        — queryPermission never answered: the stored handle is
 *                    unusable and only picking the folder again recovers it
 * - 'disconnected' — permission granted but the volume is gone (USB unplugged,
 *                    network share dropped) — manifests as NotFoundError /
 *                    NotReadableError on the iterator, or a read that never returns
 * - 'error'        — any other failure
 *
 * @param {FileSystemDirectoryHandle | null | undefined} handle
 * @param {{ permissionTimeoutMs?: number, readTimeoutMs?: number }} [opts]
 * @returns {Promise<RootStatus>}
 */
export async function probeRootStatus(handle, opts = {}) {
  const {
    permissionTimeoutMs = PERMISSION_QUERY_TIMEOUT_MS,
    readTimeoutMs = ROOT_READ_TIMEOUT_MS,
  } = opts;
  if (!handle || typeof handle !== 'object') return 'error';

  try {
    if (typeof handle.queryPermission === 'function') {
      const perm = await settleWithin(handle.queryPermission({ mode: 'read' }), permissionTimeoutMs);
      if (isTimedOut(perm)) return 'stale';
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
      const first = await settleWithin(iterator.next(), readTimeoutMs);
      if (isTimedOut(first)) return 'disconnected';
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

/**
 * hashPool.js — MD5 worker pool for concurrent file hashing.
 *
 * Usage:
 *   const pool = createHashPool();
 *   const hex  = await pool.hash(file);   // '' on timeout/error
 *   pool.dispose();
 *
 * Architecture:
 *   pending queue + fixed idle-worker array; each hash() call dequeues
 *   the next idle worker (or enqueues a waiter), sends the file, and
 *   returns the worker to the idle list when done — no worker is ever
 *   created or destroyed per-request.
 *
 * Injection point for tests:
 *   pass workerFactory to createHashPool({ workerFactory }) to supply
 *   a stub instead of a real Worker.
 */

const DEFAULT_POOL_SIZE = typeof navigator !== 'undefined'
  ? (navigator.hardwareConcurrency || 4)
  : 4;

const MAX_POOL_SIZE = 4;

const defaultWorkerFactory = () =>
  new Worker(
    new URL('../../workers/md5.worker.js', import.meta.url),
    { type: 'module' }
  );

/**
 * @param {{ poolSize?: number, workerFactory?: () => Worker }} [options]
 * @returns {{ hash: (file: File, opts?: { timeoutMs?: number }) => Promise<string>, dispose: () => void }}
 */
export function createHashPool({
  poolSize = DEFAULT_POOL_SIZE,
  workerFactory = defaultWorkerFactory,
} = {}) {
  const size = Math.min(poolSize, MAX_POOL_SIZE);

  // All workers, created eagerly so dispose() knows the full set.
  const workers = Array.from({ length: size }, workerFactory);

  // Queue of idle workers (initially all).
  const idle = [...workers];

  // Queue of pending requests waiting for a worker.
  /** @type {Array<(worker: Worker | null) => void>} */
  const waiters = [];

  let isDisposed = false;

  /** Acquire an idle worker, or wait until one becomes available. */
  function acquire() {
    return new Promise((resolve) => {
      if (idle.length > 0) {
        resolve(idle.shift());
      } else {
        waiters.push(resolve);
      }
    });
  }

  /** Return a worker to the idle pool (or hand it directly to a waiter). */
  function release(worker) {
    if (waiters.length > 0) {
      const next = waiters.shift();
      next(worker);
    } else {
      idle.push(worker);
    }
  }

  /**
   * Hash a file using a pooled worker.
   * @param {File} file
   * @param {{ timeoutMs?: number }} [opts]
   * @returns {Promise<string>} hex md5 or '' on timeout/error/disposed
   */
  async function hash(file, { timeoutMs = 10000 } = {}) {
    if (isDisposed) return '';

    const worker = await acquire();

    // Pool was disposed while this call was waiting in the queue.
    if (worker === null) return '';

    return new Promise((resolve) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // Remove listeners so the later onmessage doesn't double-release.
        worker.onmessage = null;
        worker.onerror = null;
        release(worker);
        resolve('');
      }, timeoutMs);

      worker.onmessage = (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.onmessage = null;
        worker.onerror = null;
        release(worker);
        resolve(e.data.hash ?? '');
      };

      worker.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.onmessage = null;
        worker.onerror = null;
        release(worker);
        resolve('');
      };

      worker.postMessage({ file });
    });
  }

  /** Terminate all workers. Call on component unmount. */
  function dispose() {
    if (isDisposed) return;
    isDisposed = true;
    for (const w of workers) {
      w.terminate();
    }
    // Drain waiters: resolve with null so hash() returns '' without touching
    // any terminated worker.
    while (waiters.length > 0) {
      waiters.shift()(null);
    }
  }

  return { hash, dispose };
}

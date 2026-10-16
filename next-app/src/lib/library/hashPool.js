/**
 * hashPool.js — MD5 worker pool for concurrent file hashing.
 *
 * Usage:
 *   const pool = createHashPool();
 *   const hex  = await pool.hash(file);   // '' on timeout/error/abort
 *   pool.dispose();
 *
 * Architecture:
 *   pending queue + fixed idle-worker array; each hash() call dequeues
 *   the next idle worker (or enqueues a waiter), sends the file, and
 *   returns the worker to the idle list when done. Callers queue in the
 *   order they want files read: a batch's import queues every file at
 *   once, cluster by cluster. A worker is only replaced when a hash times
 *   out (see hash()).
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
 * @returns {{ hash: (file: File, opts?: { timeoutMs?: number, signal?: AbortSignal }) => Promise<string>, dispose: () => void }}
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

  /**
   * Acquire an idle worker, or wait until one becomes available. Resolves
   * null when the pool is disposed or `signal` aborts first.
   * @param {AbortSignal} [signal]
   * @returns {Promise<Worker | null>}
   */
  function acquire(signal) {
    return new Promise((resolve) => {
      if (idle.length > 0) {
        resolve(idle.shift());
        return;
      }
      /** @param {Worker | null} worker */
      const waiter = (worker) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(worker);
      };
      const onAbort = () => {
        const at = waiters.indexOf(waiter);
        if (at >= 0) waiters.splice(at, 1);
        resolve(null);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      waiters.push(waiter);
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
   * Retire a worker that may still answer for a file it was given, and put a
   * fresh one in its place.
   * @param {Worker} worker
   */
  function replace(worker) {
    worker.terminate();
    if (isDisposed) return;
    const fresh = workerFactory();
    workers[workers.indexOf(worker)] = fresh;
    release(fresh);
  }

  /**
   * Hash a file using a pooled worker.
   *
   * `signal` takes a file that has not reached a worker yet out of the queue,
   * so an abandoned batch does not keep the pool reading. A file already
   * being read finishes.
   *
   * @param {File} file
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [opts]
   * @returns {Promise<string>} hex md5 or '' on timeout/error/disposed/aborted
   */
  async function hash(file, { timeoutMs = 10000, signal } = {}) {
    if (isDisposed || signal?.aborted) return '';

    const worker = await acquire(signal);

    // Pool was disposed, or the caller gave up, while this call was waiting
    // in the queue.
    if (worker === null) return '';

    return new Promise((resolve) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        worker.onmessage = null;
        worker.onerror = null;
        // The worker is still reading this file and will answer for it
        // later. Handed to the next file, that answer would be taken as the
        // next file's hash, and every answer after it would be one file late.
        replace(worker);
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

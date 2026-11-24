/**
 * hashPool.js — MD5 worker pool for concurrent file hashing.
 *
 * Usage:
 *   const pool = createHashPool();
 *   const hex  = await pool.hash(file);   // '' on timeout/error/abort
 *   pool.dispose();
 *
 * Architecture:
 *   pending queue + idle-worker list. Workers start only when a file needs
 *   one: hash() takes an idle worker, or starts one while fewer than the pool
 *   size are running, or queues. A worker goes back to the idle list (or
 *   straight to the next queued file) when it answers. Callers queue in the
 *   order they want files read: a batch's import queues every file at once,
 *   cluster by cluster.
 *
 *   Every worker is started through start(), which gives it its error
 *   handler. A worker raises an error when its script fails to load (a
 *   dropped connection on a phone, a blocked request); it then never answers.
 *   Such a worker leaves the pool for good: the file it was reading settles
 *   to '' at once, and if files are queued a new worker starts for the first
 *   of them, since nothing else would ever hand them one. After
 *   MAX_FAILURES_IN_A_ROW failures with no answer in between, the pool stops
 *   starting workers and every waiting and later hash() settles to ''.
 *
 *   A worker that times out is replaced at once (see replace()).
 *
 * Injection point for tests:
 *   pass workerFactory to createHashPool({ workerFactory }) to supply
 *   a stub instead of a real Worker.
 */

const DEFAULT_POOL_SIZE = typeof navigator !== 'undefined'
  ? (navigator.hardwareConcurrency || 4)
  : 4;

const MAX_POOL_SIZE = 4;

/**
 * Worker failures in a row, with no worker answering in between, after which
 * the pool gives up: by then the worker script is not coming, and starting
 * one more worker per queued file would only repeat the failure.
 */
const MAX_FAILURES_IN_A_ROW = 3;

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

  /** Workers started and not yet retired; dispose() ends these. */
  const running = new Set();

  /** Running workers with no file. */
  /** @type {Worker[]} */
  const idle = [];

  /** Requests waiting for a worker. */
  /** @type {Array<(worker: Worker | null) => void>} */
  const waiters = [];

  /**
   * How to settle the file a worker is reading, for its error handler.
   * @type {Map<Worker, () => void>}
   */
  const reading = new Map();

  let isDisposed = false;
  let hasGivenUp = false;
  let failuresInARow = 0;

  /** Start a worker with the pool's error handler. */
  function start() {
    const worker = workerFactory();
    running.add(worker);
    worker.onerror = (event) => {
      // Handled here: otherwise the browser reports it to the page as an
      // uncaught error.
      event.preventDefault();
      fail(worker);
    };
    return worker;
  }

  /**
   * Retire a worker that raised an error: it never answers after that.
   * @param {Worker} worker
   */
  function fail(worker) {
    if (isDisposed || !running.has(worker)) return;
    running.delete(worker);
    const at = idle.indexOf(worker);
    if (at >= 0) idle.splice(at, 1);
    worker.terminate();

    const settleReading = reading.get(worker);
    reading.delete(worker);
    settleReading?.();

    failuresInARow += 1;
    if (failuresInARow >= MAX_FAILURES_IN_A_ROW) {
      giveUp();
      return;
    }
    // Queued files wait for a release; with this worker gone, start one
    // for the first of them.
    if (waiters.length > 0 && running.size < size) release(start());
  }

  /** Stop starting workers; queued and later files settle to ''. */
  function giveUp() {
    hasGivenUp = true;
    while (waiters.length > 0) {
      waiters.shift()(null);
    }
  }

  /**
   * Take an idle worker, start one if the pool has room, or wait until one
   * is released. Resolves null when the pool is disposed or gives up, or
   * when `signal` aborts first.
   * @param {AbortSignal} [signal]
   * @returns {Promise<Worker | null>}
   */
  function acquire(signal) {
    return new Promise((resolve) => {
      if (idle.length > 0) {
        resolve(idle.shift());
        return;
      }
      if (running.size < size) {
        resolve(start());
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
    running.delete(worker);
    worker.terminate();
    if (isDisposed || hasGivenUp) return;
    release(start());
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
    if (isDisposed || hasGivenUp || signal?.aborted) return '';

    const worker = await acquire(signal);

    // Pool was disposed or gave up, or the caller gave up, while this call
    // was waiting in the queue.
    if (worker === null) return '';

    return new Promise((resolve) => {
      let settled = false;

      /** Stop listening for this file; true when it was still open. */
      const close = () => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        worker.onmessage = null;
        reading.delete(worker);
        return true;
      };

      const timer = setTimeout(() => {
        if (!close()) return;
        // The worker is still reading this file and will answer for it
        // later. Handed to the next file, that answer would be taken as the
        // next file's hash, and every answer after it would be one file late.
        replace(worker);
        resolve('');
      }, timeoutMs);

      worker.onmessage = (e) => {
        if (!close()) return;
        failuresInARow = 0;
        release(worker);
        resolve(e.data.hash ?? '');
      };

      // The worker's error handler (see start()) settles this file.
      reading.set(worker, () => {
        if (close()) resolve('');
      });

      worker.postMessage({ file });
    });
  }

  /** Terminate all workers. Call on component unmount. */
  function dispose() {
    if (isDisposed) return;
    isDisposed = true;
    for (const w of running) {
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

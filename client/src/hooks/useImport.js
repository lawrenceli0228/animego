// @ts-check
import { useState, useCallback, useRef, useEffect } from 'react';
import { runImport } from '../services/importPipeline.js';
import { createHashPool } from '../lib/library/hashPool.js';

/** @typedef {import('../lib/library/types').ImportEvent} ImportEvent */
/** @typedef {import('../lib/library/types').EpisodeItem} EpisodeItem */
/** @typedef {import('../services/importPipeline').ImportSummary} ImportSummary */
/** @typedef {'idle'|'running'|'done'|'error'} ImportStatus */
/** @typedef {{ hash: (file: File, opts?: { timeoutMs?: number }) => Promise<string>, dispose: () => void }} HashPool */

/**
 * React hook wrapping runImport with observable progress, status, and cancel.
 *
 * P4-E adds a hash phase: items missing `hash16M` are routed through an md5
 * worker pool before being passed downstream. This is what unlocks matchCache
 * reuse — without a stable hash on the cluster representative, every re-import
 * minted a fresh series ulid.
 *
 * DI seam: accepts { db, dandan, hashPool } so tests can inject mocks.
 *
 * @param {{
 *   db: import('dexie').Dexie,
 *   dandan: { match(hash: string, fileName: string): Promise<any> },
 *   hashPool?: HashPool
 * }} options
 * @returns {{
 *   run(input: { items: EpisodeItem[], libraryId: string }): Promise<void>,
 *   progress: ImportEvent[],
 *   summary: ImportSummary|null,
 *   status: ImportStatus,
 *   error: string|null,
 *   cancel(): void,
 * }}
 */
export default function useImport({ db, dandan, hashPool: injectedPool }) {
  const [status, setStatus] = useState(/** @type {ImportStatus} */ ('idle'));
  const [progress, setProgress] = useState(/** @type {ImportEvent[]} */ ([]));
  const [summary, setSummary] = useState(/** @type {ImportSummary|null} */ (null));
  const [error, setError] = useState(/** @type {string|null} */ (null));

  /** Used to signal cancellation to the in-flight run */
  const cancelledRef = useRef(false);

  /** Lazily-created hash pool when no injected pool is provided. */
  const ownedPoolRef = useRef(/** @type {HashPool|null} */ (null));

  // Dispose any pool we own when the hook unmounts. Injected pools are owned
  // by the caller — we never dispose those.
  useEffect(() => {
    return () => {
      if (ownedPoolRef.current) {
        ownedPoolRef.current.dispose();
        ownedPoolRef.current = null;
      }
    };
  }, []);

  /**
   * Cancel the in-flight import. Partial results are retained.
   */
  const cancel = useCallback(() => {
    cancelledRef.current = true;
  }, []);

  /**
   * Run the full import pipeline.
   * Resets progress on each call; partial events are retained even if cancelled.
   *
   * @param {{ items: EpisodeItem[], libraryId: string }} input
   * @returns {Promise<void>}
   */
  const run = useCallback(async (input) => {
    cancelledRef.current = false;
    setProgress([]);
    setSummary(null);
    setError(null);
    setStatus('running');

    try {
      // Hash phase — fill in hash16M for items missing it. Pool throttles
      // concurrent worker use, so Promise.all is safe even on large batches.
      // A pool failure (timeout, dispose) returns '' → we let the item proceed
      // without a hash; the pipeline degrades to "no cache, no reuse" rather
      // than aborting the whole import.
      //
      // Pool creation is deferred until at least one item actually needs
      // hashing — so callers passing pre-hashed items never spawn a real Worker
      // (matters in JSDOM tests, and is also the right thing for free).
      const items = input.items ?? [];
      const needsHashing = items.some(it => !it.hash16M && it.file);
      const pool = needsHashing
        ? (injectedPool ?? (ownedPoolRef.current ??= createHashPool()))
        : null;

      const hashed = await Promise.all(items.map(async (item) => {
        if (item.hash16M) return item;
        if (!item.file || !pool) return item;
        const h = await pool.hash(item.file);
        return h ? { ...item, hash16M: h } : item;
      }));

      if (cancelledRef.current) {
        setStatus('idle');
        return;
      }

      const result = await runImport(
        { items: hashed, libraryId: input.libraryId },
        {
          db,
          dandan,
          onEvent: (event) => {
            if (cancelledRef.current) return;
            setProgress(prev => [...prev, event]);
          },
        },
      );

      if (!cancelledRef.current) {
        setSummary(result);
        setStatus('done');
      } else {
        setSummary(result);
        setStatus('idle');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!cancelledRef.current) {
        setError(msg);
        setStatus('error');
      } else {
        setStatus('idle');
      }
    }
  }, [db, dandan, injectedPool]);

  return { run, progress, summary, status, error, cancel };
}

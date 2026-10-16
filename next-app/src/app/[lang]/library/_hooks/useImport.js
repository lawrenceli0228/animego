"use client";
// @ts-nocheck
import { useState, useCallback, useRef, useEffect } from 'react';
import { runImport } from '../_services/importPipeline.js';
import { createHashPool } from '@/lib/library/hashPool.js';

/** @typedef {import('@/lib/library/types').ImportEvent} ImportEvent */
/** @typedef {import('@/lib/library/types').EpisodeItem} EpisodeItem */
/** @typedef {import('../_services/importPipeline').ImportSummary} ImportSummary */
/** @typedef {'idle'|'running'|'done'|'error'} ImportStatus */
/** @typedef {{ hash: (file: File, opts?: { timeoutMs?: number, signal?: AbortSignal }) => Promise<string>, dispose: () => void }} HashPool */

/**
 * React hook wrapping runImport with observable progress, status, and cancel.
 *
 * P4-E adds hashing: items missing `hash16M` are routed through an md5 worker
 * pool. This is what unlocks matchCache reuse — without a stable hash on the
 * cluster representative, every re-import minted a fresh series ulid. The
 * pipeline hashes cluster by cluster while it imports (hashClustersInOrder),
 * rather than the whole batch before the first cluster.
 *
 * DI seam: accepts { db, dandan, hashPool } so tests can inject mocks.
 *
 * @param {{
 *   db: import('dexie').Dexie,
 *   dandan: { match(hash: string, fileName: string): Promise<any> },
 *   hashPool?: HashPool
 * }} options
 * @returns {{
 *   run(input: { items: EpisodeItem[], libraryId: string, onDisk?: Map<string, Set<string>> }): Promise<void>,
 *   progress: ImportEvent[],
 *   summary: ImportSummary|null,
 *   status: ImportStatus,
 *   error: string|null,
 *   cancel(): void,
 * }}
 */
export function useImport({ db, dandan, hashPool: injectedPool }) {
  const [status, setStatus] = useState(/** @type {ImportStatus} */ ('idle'));
  const [progress, setProgress] = useState(/** @type {ImportEvent[]} */ ([]));
  const [summary, setSummary] = useState(/** @type {ImportSummary|null} */ (null));
  const [error, setError] = useState(/** @type {string|null} */ (null));

  /**
   * One controller per run in flight. Aborting one stops that run between
   * clusters and takes its files still waiting off the hash pool. Each run
   * has its own: a shared flag was reset by the next run, so a cancelled run
   * went on importing files whose reads had been cut short.
   */
  const runsRef = useRef(/** @type {Set<AbortController>} */ (new Set()));

  /** Lazily-created hash pool when no injected pool is provided. */
  const ownedPoolRef = useRef(/** @type {HashPool|null} */ (null));

  // On unmount, stop the runs before disposing any pool we own. Left running
  // without a pool, a run would import the files still being read under
  // name-and-size ids; stopped, it leaves them for the next scan. Injected
  // pools are owned by the caller — we never dispose those.
  useEffect(() => {
    const runs = runsRef.current;
    return () => {
      for (const running of runs) running.abort();
      if (ownedPoolRef.current) {
        ownedPoolRef.current.dispose();
        ownedPoolRef.current = null;
      }
    };
  }, []);

  /**
   * Cancel the in-flight import. Partial results are retained: clusters
   * already imported stay, the rest are left for the next scan.
   */
  const cancel = useCallback(() => {
    for (const running of runsRef.current) running.abort();
  }, []);

  /**
   * Run the full import pipeline.
   * Resets progress on each call; partial events are retained even if cancelled.
   *
   * `onDisk` (optional) is what is on disk now, per library folder (see
   * OnDisk in rescanService); the pipeline uses it to tell a second copy of
   * a known file from a moved one (see importPipeline.runImport).
   *
   * @param {{ items: EpisodeItem[], libraryId: string, onDisk?: Map<string, Set<string>> }} input
   * @returns {Promise<void>}
   */
  const run = useCallback(async (input) => {
    const abort = new AbortController();
    const stopped = () => abort.signal.aborted;
    runsRef.current.add(abort);
    setProgress([]);
    setSummary(null);
    setError(null);
    setStatus('running');

    try {
      // The pipeline fills in hash16M for items missing it, cluster by
      // cluster. The pool throttles concurrent worker use, so the whole batch
      // can be queued at once. A pool failure (timeout, dispose) returns '' →
      // the item proceeds without a hash; the pipeline degrades to "no cache,
      // no reuse" rather than aborting the whole import.
      //
      // Pool creation is deferred until at least one item actually needs
      // hashing — so callers passing pre-hashed items never spawn a real Worker
      // (matters in JSDOM tests, and is also the right thing for free).
      const items = input.items ?? [];
      const needsHashing = items.some(it => !it.hash16M && it.file);
      const pool = needsHashing
        ? (injectedPool ?? (ownedPoolRef.current ??= createHashPool()))
        : null;

      const result = await runImport(
        { items, libraryId: input.libraryId, onDisk: input.onDisk },
        {
          db,
          dandan,
          hashFile: pool ? (file) => pool.hash(file, { signal: abort.signal }) : undefined,
          shouldStop: stopped,
          onEvent: (event) => {
            if (stopped()) return;
            setProgress(prev => [...prev, event]);
          },
        },
      );

      if (!stopped()) {
        setSummary(result);
        setStatus('done');
      } else {
        setSummary(result);
        setStatus('idle');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!stopped()) {
        setError(msg);
        setStatus('error');
      } else {
        setStatus('idle');
      }
    } finally {
      runsRef.current.delete(abort);
    }
  }, [db, dandan, injectedPool]);

  return { run, progress, summary, status, error, cancel };
}

export default useImport;

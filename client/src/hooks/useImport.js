// @ts-check
import { useState, useCallback, useRef } from 'react';
import { runImport } from '../services/importPipeline.js';

/** @typedef {import('../lib/library/types').ImportEvent} ImportEvent */
/** @typedef {import('../services/importPipeline').ImportSummary} ImportSummary */
/** @typedef {'idle'|'running'|'done'|'error'} ImportStatus */

/**
 * React hook wrapping runImport with observable progress, status, and cancel.
 *
 * DI seam: accepts { db, dandan } so tests can inject mocks.
 *
 * @param {{ db: import('dexie').Dexie, dandan: { match(hash: string, fileName: string): Promise<any> } }} options
 * @returns {{
 *   run(input: { items: any[], libraryId: string }): Promise<void>,
 *   progress: ImportEvent[],
 *   summary: ImportSummary|null,
 *   status: ImportStatus,
 *   cancel(): void,
 * }}
 */
export default function useImport({ db, dandan }) {
  const [status, setStatus] = useState(/** @type {ImportStatus} */ ('idle'));
  const [progress, setProgress] = useState(/** @type {ImportEvent[]} */ ([]));
  const [summary, setSummary] = useState(/** @type {ImportSummary|null} */ (null));

  /** Used to signal cancellation to the in-flight run */
  const cancelledRef = useRef(false);

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
   * @param {{ items: any[], libraryId: string }} input
   * @returns {Promise<void>}
   */
  const run = useCallback(async (input) => {
    cancelledRef.current = false;
    setProgress([]);
    setSummary(null);
    setStatus('running');

    try {
      const result = await runImport(input, {
        db,
        dandan,
        onEvent: (event) => {
          if (cancelledRef.current) return;
          setProgress(prev => [...prev, event]);
        },
      });

      if (!cancelledRef.current) {
        setSummary(result);
        setStatus('done');
      } else {
        setSummary(result);
        setStatus('idle');
      }
    } catch (err) {
      if (!cancelledRef.current) {
        setStatus('error');
      } else {
        setStatus('idle');
      }
    }
  }, [db, dandan]);

  return { run, progress, summary, status, cancel };
}

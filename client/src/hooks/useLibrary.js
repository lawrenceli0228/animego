// @ts-check
import { useSyncExternalStore, useCallback, useRef } from 'react';
import { liveQuery } from 'dexie';

/** @typedef {import('../lib/library/types').Series} Series */

/**
 * Build a useSyncExternalStore-compatible store from a Dexie liveQuery.
 *
 * @template T
 * @param {() => import('dexie').Observable<T>} querier
 * @returns {{ subscribe(l: () => void): () => void, getSnapshot(): T|null, destroy(): void }}
 */
function makeLiveQueryStore(querier) {
  /** @type {T|null} */
  let snapshot = null;
  /** @type {Set<() => void>} */
  const listeners = new Set();

  const sub = querier().subscribe({
    next: (v) => {
      snapshot = v;
      listeners.forEach(l => l());
    },
    error: () => {
      listeners.forEach(l => l());
    },
  });

  return {
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getSnapshot: () => snapshot,
    destroy: () => sub.unsubscribe(),
  };
}

/**
 * React hook that subscribes to the series table via Dexie liveQuery.
 * Uses useSyncExternalStore to avoid React 19 concurrent-mode tearing.
 *
 * @param {{ db: import('dexie').Dexie }} options
 * @returns {{
 *   series: Series[],
 *   loading: boolean,
 *   refetch(): void,
 * }}
 */
export default function useLibrary({ db }) {
  // Revision counter forces a new liveQuery store on refetch()
  const revRef = useRef(0);
  const storeRef = useRef(/** @type {ReturnType<typeof makeLiveQueryStore<Series[]>>|null} */ (null));

  // Build or reuse the store for the current revision
  function getStore() {
    if (!storeRef.current) {
      storeRef.current = makeLiveQueryStore(() =>
        liveQuery(() => db.series.orderBy('updatedAt').reverse().toArray())
      );
    }
    return storeRef.current;
  }

  const store = getStore();

  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    () => /** @type {Series[]} */ ([]),
  );

  const loading = snapshot === null;
  const series = snapshot ?? [];

  /**
   * Force a re-read of the series store by destroying and recreating the live query.
   */
  const refetch = useCallback(() => {
    if (storeRef.current) {
      storeRef.current.destroy();
      storeRef.current = null;
    }
    storeRef.current = makeLiveQueryStore(() =>
      liveQuery(() => db.series.orderBy('updatedAt').reverse().toArray())
    );
    // Trigger re-render via the existing subscribe mechanism
    storeRef.current.subscribe(() => {})();
  }, [db]);

  return { series, loading, refetch };
}

// @ts-check
import { useSyncExternalStore, useCallback, useState, useEffect, useMemo } from 'react';
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
  const [rev, setRev] = useState(0);

  // Recreate the store when db or rev changes; destroy on unmount/dep-change.
  const store = useMemo(
    () => makeLiveQueryStore(() =>
      liveQuery(() => db.series.orderBy('updatedAt').reverse().toArray())
    ),
    [db, rev],
  );

  useEffect(() => () => store.destroy(), [store]);

  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    () => /** @type {Series[]} */ ([]),
  );

  const loading = snapshot === null;
  const series = snapshot ?? [];

  /** Force a re-read by recreating the live query. */
  const refetch = useCallback(() => {
    setRev(r => r + 1);
  }, []);

  return { series, loading, refetch };
}

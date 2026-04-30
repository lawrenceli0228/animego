// @ts-check
import { useSyncExternalStore, useCallback, useState, useRef } from 'react';
import { liveQuery } from 'dexie';

/** @typedef {import('../lib/library/types').Series} Series */

/**
 * React hook that subscribes to the series table via Dexie liveQuery.
 *
 * Subscription lifecycle lives inside the subscribe callback so React
 * (incl. 19 strict-mode dev double-invoke) owns subscribe/unsubscribe.
 *
 * @param {{ db: import('dexie').Dexie }} options
 * @returns {{
 *   series: Series[],
 *   loading: boolean,
 *   refetch(): void,
 * }}
 */
export default function useLibrary({ db }) {
  const [rev, setRev] = useState(0);

  /** @type {React.MutableRefObject<Series[] | null>} */
  const snapshotRef = useRef(null);
  /** Track which (db, rev) the current snapshot belongs to so we don't serve stale data after refetch. */
  const snapshotKeyRef = useRef(/** @type {{ db: any, rev: number } | null} */(null));

  const subscribe = useCallback(
    (onChange) => {
      // Reset on (re)subscribe so a fresh liveQuery yields a fresh snapshot.
      snapshotRef.current = null;
      snapshotKeyRef.current = { db, rev };

      const sub = liveQuery(() =>
        db.series.orderBy('updatedAt').reverse().toArray()
      ).subscribe({
        next: (v) => {
          snapshotRef.current = /** @type {Series[]} */ (v);
          onChange();
        },
        error: () => {
          snapshotRef.current = [];
          onChange();
        },
      });

      return () => {
        sub.unsubscribe();
      };
    },
    [db, rev],
  );

  const getSnapshot = useCallback(() => {
    const key = snapshotKeyRef.current;
    if (!key || key.db !== db || key.rev !== rev) return null;
    return snapshotRef.current;
  }, [db, rev]);

  const getServerSnapshot = useCallback(() => /** @type {Series[]} */ ([]), []);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const loading = snapshot === null;
  const series = snapshot ?? [];

  const refetch = useCallback(() => {
    setRev((r) => r + 1);
  }, []);

  return { series, loading, refetch };
}

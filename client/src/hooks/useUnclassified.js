// @ts-check
import { useSyncExternalStore, useCallback, useRef, useMemo } from 'react';
import { liveQuery } from 'dexie';

/** @typedef {import('../lib/library/types').FileRef} FileRef */

const UNCLASSIFIED_STATUSES = ['pending', 'failed', 'ambiguous'];

/**
 * Live-subscribe to unclassified fileRefs across all libraries.
 *
 * Returns rows with matchStatus in pending|failed|ambiguous, sorted by relPath.
 * Empty array while still loading the first snapshot — caller can disambiguate
 * via the `loading` flag.
 *
 * @param {{ db: import('dexie').Dexie }} options
 * @returns {{ entries: FileRef[], loading: boolean }}
 */
export default function useUnclassified({ db }) {
  /** @type {React.MutableRefObject<FileRef[]|null>} */
  const snapshotRef = useRef(null);
  const snapshotKeyRef = useRef(/** @type {{ db: any }|null} */(null));

  const subscribe = useCallback((onChange) => {
    snapshotRef.current = null;
    snapshotKeyRef.current = { db };

    const sub = liveQuery(async () => {
      const rows = await db.fileRefs
        .where('matchStatus')
        .anyOf(UNCLASSIFIED_STATUSES)
        .toArray();
      rows.sort((a, b) => (a.relPath || '').localeCompare(b.relPath || ''));
      return rows;
    }).subscribe({
      next: (v) => {
        snapshotRef.current = v;
        onChange();
      },
      error: () => {
        snapshotRef.current = [];
        onChange();
      },
    });

    return () => sub.unsubscribe();
  }, [db]);

  const getSnapshot = useCallback(() => {
    const key = snapshotKeyRef.current;
    if (!key || key.db !== db) return null;
    return snapshotRef.current;
  }, [db]);

  const getServerSnapshot = useCallback(() => /** @type {FileRef[]} */ ([]), []);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  return useMemo(
    () => ({
      entries: snapshot ?? [],
      loading: snapshot === null,
    }),
    [snapshot],
  );
}

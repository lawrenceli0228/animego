// @ts-check
import { useSyncExternalStore, useCallback, useRef, useMemo } from 'react';
import { liveQuery } from 'dexie';
import { makeUserOverrideRepo } from '../lib/library/db/userOverrideRepo.js';

/** @typedef {import('../lib/library/types').UserOverride} UserOverride */

/**
 * Subscribe to all userOverride rows and expose mutation helpers.
 *
 * Single page-level subscription is intentional — one query that produces a
 * Map keyed by seriesId scales to thousands of cards without thrashing IDB,
 * whereas one liveQuery per card would not.
 *
 * `unlock` keeps `overrideSeasonAnimeId` so users don't lose a manually
 * picked animeId when they toggle the lock off; only `clear` removes the
 * row entirely.
 *
 * @param {{ db: import('dexie').Dexie }} options
 * @returns {{
 *   all: Map<string, UserOverride>,
 *   loading: boolean,
 *   lock(seriesId: string, animeId?: number): Promise<UserOverride>,
 *   unlock(seriesId: string): Promise<UserOverride>,
 *   clear(seriesId: string): Promise<void>,
 *   update(seriesId: string, partial: Partial<UserOverride>): Promise<UserOverride>,
 * }}
 */
export default function useUserOverride({ db }) {
  const repoRef = useRef(/** @type {ReturnType<typeof makeUserOverrideRepo>|null} */ (null));
  if (repoRef.current === null) {
    repoRef.current = makeUserOverrideRepo(db);
  }

  /** @type {React.MutableRefObject<Map<string, UserOverride>|null>} */
  const snapshotRef = useRef(null);
  const snapshotKeyRef = useRef(/** @type {{ db: any }|null} */ (null));

  const subscribe = useCallback(
    (onChange) => {
      snapshotRef.current = null;
      snapshotKeyRef.current = { db };

      const sub = liveQuery(async () => {
        const rows = await db.userOverride.toArray();
        /** @type {Map<string, UserOverride>} */
        const map = new Map();
        for (const r of rows) map.set(r.seriesId, r);
        return map;
      }).subscribe({
        next: (v) => {
          snapshotRef.current = v;
          onChange();
        },
        error: () => {
          snapshotRef.current = new Map();
          onChange();
        },
      });

      return () => sub.unsubscribe();
    },
    [db],
  );

  const getSnapshot = useCallback(() => {
    const key = snapshotKeyRef.current;
    if (!key || key.db !== db) return null;
    return snapshotRef.current;
  }, [db]);

  const getServerSnapshot = useCallback(
    () => /** @type {Map<string, UserOverride>} */ (new Map()),
    [],
  );

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const lock = useCallback(
    /** @type {(seriesId: string, animeId?: number) => Promise<UserOverride>} */
    async (seriesId, animeId) => {
      const patch = animeId != null
        ? { locked: true, overrideSeasonAnimeId: animeId }
        : { locked: true };
      return repoRef.current.update(seriesId, patch);
    },
    [],
  );

  const unlock = useCallback(
    /** @type {(seriesId: string) => Promise<UserOverride>} */
    async (seriesId) => repoRef.current.update(seriesId, { locked: false }),
    [],
  );

  const clear = useCallback(
    /** @type {(seriesId: string) => Promise<void>} */
    async (seriesId) => repoRef.current.delete(seriesId),
    [],
  );

  const update = useCallback(
    /** @type {(seriesId: string, partial: Partial<UserOverride>) => Promise<UserOverride>} */
    async (seriesId, partial) => repoRef.current.update(seriesId, partial),
    [],
  );

  return useMemo(
    () => ({
      all: snapshot ?? new Map(),
      loading: snapshot === null,
      lock,
      unlock,
      clear,
      update,
    }),
    [snapshot, lock, unlock, clear, update],
  );
}

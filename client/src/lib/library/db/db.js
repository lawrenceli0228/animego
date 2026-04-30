// @ts-check
// Dexie schema v4 for the animego local library (v3.1 added opsLog).
// Pure data layer — no React, no DOM, no service layer.

import Dexie from 'dexie';

/** @type {Map<string, Dexie>} */
const _instances = new Map();

/**
 * Apply schema (v3 → v4) to a Dexie instance.
 * v4 adds `opsLog` for §5.6 undo (24h) and series-detail operation log.
 * @param {Dexie} instance
 */
function applySchema(instance) {
  instance.version(3).stores({
    libraries:   'id, name, updatedAt',
    series:      'id, titleZh, updatedAt',
    seasons:     'id, seriesId, animeId, [seriesId+number]',
    episodes:    'id, seriesId, seasonId, [seriesId+number], episodeId',
    fileRefs:    'id, episodeId, hash16M, matchStatus, [libraryId+matchStatus], *libraryIds',
    matchCache:  'hash16M, updatedAt',
    fileHandles: 'id, libraryId',
  });
  instance.version(4).stores({
    opsLog:      'id, [seriesId+ts], undoableUntil, ts',
  });
}

/**
 * Get (or create) a named Dexie instance.
 * Instances are cached by name — calling with the same name returns the same object.
 *
 * @param {string} [dbName='animego-library']
 * @returns {Dexie}
 */
export function getDb(dbName = 'animego-library') {
  if (_instances.has(dbName)) {
    return /** @type {Dexie} */ (_instances.get(dbName));
  }
  const instance = new Dexie(dbName);
  applySchema(instance);

  // Wrap open errors with a clear message
  const origOpen = instance.open.bind(instance);
  instance.open = async function (...args) {
    try {
      return await origOpen(...args);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[animego-library] Failed to open IndexedDB "${dbName}": ${msg}`);
    }
  };

  _instances.set(dbName, instance);
  return instance;
}

/**
 * Default singleton database instance (name: "animego-library").
 * Import this for all production use.
 * @type {Dexie}
 */
export const db = getDb('animego-library');

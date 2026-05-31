// @ts-nocheck
// Dexie schema v5 for the animego local library.
// Pure data layer — no React, no DOM, no service layer.

import Dexie from 'dexie';

// P6 SERVER-ONLY GUARD
// --------------------
// This module is browser-only. It declares a module-level
// `export const db = getDb(...)` at the bottom, which calls
// `new Dexie(dbName)` on import; Dexie touches `indexedDB`, which is
// undefined on a Node server. Any accidental import from a Server
// Component path will crash at build / SSR time with a confusing
// "indexedDB is not defined" trace.
//
// We surface a clear error up front. Every consumer of this module
// MUST live behind a `'use client'` boundary (and ideally the route
// page MUST use `next/dynamic` with `{ ssr: false }` to skip the
// SSR pass entirely — see next-app/src/app/library/page.tsx).
if (typeof window === 'undefined') {
  throw new Error(
    '[animego-library] db.js was imported on the server. ' +
    'This module is browser-only (IndexedDB). Wrap consumers in ' +
    "`'use client'` and load the page via `next/dynamic({ ssr: false })`.",
  );
}

/** @type {Map<string, Dexie>} */
const _instances = new Map();

/**
 * Apply schema (v3 → v4 → v5) to a Dexie instance.
 * v4 adds `opsLog` for §5.6 undo (24h) and series-detail operation log.
 * v5 adds `progress` (per-episode resume), `userOverride` (manual merge/split/lock memory),
 *        `migrationFailures` (legacy progress migration triage queue).
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
  instance.version(5).stores({
    progress:           'episodeId, seriesId, updatedAt, [seriesId+updatedAt]',
    userOverride:       'seriesId, updatedAt',
    migrationFailures:  'key, attemptedAt',
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

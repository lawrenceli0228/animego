// @ts-nocheck
// Dexie schema v6 for the animego local library.
// Pure data layer — no React, no DOM, no service layer.

import Dexie from 'dexie';
import {
  describeDbOpenFailure,
  makeDbBlockedError,
  makeDbBlockedState,
} from './dbOpenErrors.js';

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

/**
 * How long we let a `blocked` upgrade sit before turning it into an error.
 *
 * `blocked` fires the moment another tab holds an older connection, but that
 * tab is usually about to release it (our own `versionchange` handler closes
 * it). Rejecting instantly would produce a false alarm on every multi-tab
 * upgrade; never rejecting is the spinner-forever bug this constant exists to
 * kill. A few seconds is long enough for the release to land and short enough
 * that nobody stares at a spinner wondering if their library is gone.
 */
const UPGRADE_BLOCKED_GRACE_MS = 3000;

/** @type {Map<string, Dexie>} */
const _instances = new Map();

/**
 * dbName → subscribers of the "upgrade is blocked" state.
 * @type {Map<string, Set<(state: import('./dbOpenErrors.js').DbBlockedState) => void>>}
 */
const _blockedListeners = new Map();

/**
 * Subscribe to "this tab's upgrade is stuck behind another tab's connection".
 *
 * This, not the rejected `open()` promise, is the surface UI should render.
 * Dexie's auto-open path calls `db.open().catch(nop)` and then awaits its own
 * internal ready-promise (`dexie.js:1185-1188`), so a rejection from the open
 * wrapper below is swallowed and the caller keeps waiting. Anything that wants
 * to tell the user "close your other AnimeGo tabs" has to hear about it from
 * the event, not from a query that will simply never come back.
 *
 * The listener is called with `blocked: true` once the grace period lapses and
 * again with `blocked: false` if the upgrade later goes through, so a banner can
 * be shown and taken down without any extra bookkeeping at the call site.
 *
 * @param {(state: import('./dbOpenErrors.js').DbBlockedState) => void} listener
 * @param {string} [dbName='animego-library']
 * @returns {() => void} unsubscribe
 */
export function onLibraryDbBlocked(listener, dbName = 'animego-library') {
  if (typeof listener !== 'function') {
    throw new TypeError('onLibraryDbBlocked: listener must be a function');
  }
  let set = _blockedListeners.get(dbName);
  if (!set) {
    set = new Set();
    _blockedListeners.set(dbName, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

/**
 * @param {string} dbName
 * @param {boolean} blocked
 */
function emitBlockedState(dbName, blocked) {
  const listeners = _blockedListeners.get(dbName);
  if (!listeners || listeners.size === 0) return;
  const state = makeDbBlockedState(blocked);
  for (const listener of [...listeners]) {
    try {
      listener(state);
    } catch {
      // A broken banner must not take down the database layer with it.
    }
  }
}

/**
 * Apply schema (v3 → v4 → v5 → v6) to a Dexie instance.
 * v4 adds `opsLog` for §5.6 undo (24h) and series-detail operation log.
 * v5 adds `progress` (per-episode resume), `userOverride` (manual merge/split/lock memory),
 *        `migrationFailures` (legacy progress migration triage queue).
 * v6 adds `series.anilistId` — the persistent local-episode ↔ AniList link that
 *        watch-progress sync needs. Indexed on purpose: the index buys the
 *        reverse lookup (anilistId → local series) the reconciler uses for free.
 *        `series.lastSyncedEpisode` lands in the same version but is NOT indexed
 *        — it is only ever read by seriesId (the primary key).
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
  instance.version(6).stores({
    series:      'id, titleZh, anilistId, updatedAt',
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

  // CG3 — multi-tab upgrade deadlock.
  // ---------------------------------
  // This module opens a connection at import time, so every `/library` and
  // `/player` tab holds one. When a tab running the new build starts the v6
  // upgrade, every older tab's connection blocks it. IndexedDB does not fail
  // here — it just never proceeds, so the failure the user experiences is an
  // infinite spinner over a library that looks deleted.
  //
  // Two halves, both needed:
  //   versionchange → the fix. The OLD tab gets this and gets out of the way.
  //   blocked       → the backstop. The NEW tab gets this and, if the old tab
  //                   does not release in time (pinned tab, frozen renderer,
  //                   a build old enough to predate this handler), turns the
  //                   wait into a message that tells the user what to do.
  //
  // Dexie's own default `blocked` subscriber only console.warns, which is the
  // silent half of the gap: nothing reaches the user at all.

  /** @type {Set<(err: Error) => void>} — one entry per in-flight open() call. */
  const blockedWaiters = new Set();
  /** @type {ReturnType<typeof setTimeout>|null} */
  let blockedTimer = null;
  let blockedAnnounced = false;

  /** The upgrade got through after all — retract the warning if we gave one. */
  function clearBlocked() {
    if (blockedTimer !== null) {
      clearTimeout(blockedTimer);
      blockedTimer = null;
    }
    if (blockedAnnounced) {
      blockedAnnounced = false;
      emitBlockedState(dbName, false);
    }
  }

  instance.on('blocked', () => {
    if (blockedTimer !== null) return; // grace period already running
    blockedTimer = setTimeout(() => {
      blockedAnnounced = true;
      const err = makeDbBlockedError(dbName);
      for (const notify of [...blockedWaiters]) notify(err);
      emitBlockedState(dbName, true);
    }, UPGRADE_BLOCKED_GRACE_MS);
  });

  instance.on('versionchange', () => {
    // `disableAutoOpen: false` matters: this tab releases the connection so the
    // other tab's upgrade can finish, then transparently re-opens on its next
    // query. Closing with auto-open disabled would leave THIS tab's library
    // permanently dead instead — trading one stuck tab for another.
    //
    // Dexie 4 ships a default versionchange subscriber that does exactly this.
    // We keep an explicit one anyway: subscribers chain rather than replace, so
    // this is a no-op today and a guard the day that default changes.
    instance.close({ disableAutoOpen: false });
  });

  // Wrap open errors with a clear message
  const origOpen = instance.open.bind(instance);
  instance.open = async function (...args) {
    /** @type {(err: Error) => void} */
    let rejectAsBlocked = () => {};
    const blocked = new Promise((_resolve, reject) => {
      rejectAsBlocked = reject;
    });
    blockedWaiters.add(rejectAsBlocked);

    const opening = origOpen(...args);
    // Whatever the race below decides, the REAL open may still succeed later —
    // the other tab closes, the upgrade goes through. Retract the warning when
    // it does, so a banner raised by a slow release does not stay up forever.
    opening.then(clearBlocked, () => {});

    try {
      // `blocked` only ever rejects, and only after the grace period, so a
      // normal open is untouched by this race.
      return await Promise.race([opening, blocked]);
    } catch (err) {
      throw new Error(describeDbOpenFailure(dbName, err), { cause: err });
    } finally {
      blockedWaiters.delete(rejectAsBlocked);
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

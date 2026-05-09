// @ts-check
import { useEffect, useState } from 'react';

/**
 * @typedef {Object} WatchRhythm
 * @property {number} thisWeek      - episodes touched since Mon 00:00 local
 * @property {number} streak        - consecutive days with at least one progress event
 * @property {boolean[]} past14     - 14 buckets, oldest first; true if that local-date had ≥1 event
 * @property {number} totalDays     - days with any record across the 14d window
 * @property {boolean} loaded       - false until the one-shot fetch resolves
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Local date key (YYYY-MM-DD) for a unix-ms timestamp. Used to dedup events
 * that landed on the same calendar day regardless of how many episodes the
 * user touched.
 *
 * @param {number} ts
 */
function dateKey(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Most-recent-Monday 00:00 local time, in unix ms. JS Date.getDay() returns
 * 0 for Sunday and 1 for Monday — we treat Monday as week start.
 */
function startOfThisWeek() {
  const now = new Date();
  const dow = now.getDay() === 0 ? 6 : now.getDay() - 1; // 0..6 with Mon=0
  const monday = new Date(now);
  monday.setDate(now.getDate() - dow);
  monday.setHours(0, 0, 0, 0);
  return monday.getTime();
}

/**
 * useWatchRhythm — single-shot 14-day progress aggregation.
 *
 * Reads `db.progress` once on mount, computes the rhythm summary, then exits.
 * Not reactive — the page-level rhythm doesn't need to flicker on every save;
 * the next mount picks up the updated state. If you want live updates, swap
 * the body for a Dexie liveQuery — the shape stays the same.
 *
 * Returns an empty/loading shape until the fetch resolves so callers can
 * render skeletons without `null` checks.
 *
 * @param {{ db: import('dexie').Dexie }} options
 * @returns {WatchRhythm}
 */
export default function useWatchRhythm({ db }) {
  const [state, setState] = useState(/** @type {WatchRhythm} */ ({
    thisWeek: 0,
    streak: 0,
    past14: new Array(14).fill(false),
    totalDays: 0,
    loaded: false,
  }));

  useEffect(() => {
    let cancelled = false;
    // jsdom + most unit-test envs have no IndexedDB. Bail early so callers
    // get a stable "loaded but empty" shape instead of an unhandled rejection.
    if (typeof indexedDB === 'undefined') {
      setState((prev) => ({ ...prev, loaded: true }));
      return undefined;
    }
    const since = Date.now() - 14 * DAY_MS;
    let promise;
    try {
      promise = db.progress.where('updatedAt').above(since).toArray();
    } catch {
      setState((prev) => ({ ...prev, loaded: true }));
      return undefined;
    }
    promise
      .then((rows) => {
        if (cancelled) return;
        const weekStart = startOfThisWeek();

        // Per-day boolean grid for the past 14 days, oldest → newest. We
        // bucket each event by its local-date key, then walk a sliding 14d
        // window relative to today.
        /** @type {Set<string>} */
        const dayKeys = new Set();
        let thisWeek = 0;
        for (const p of rows) {
          if (typeof p?.updatedAt !== 'number') continue;
          dayKeys.add(dateKey(p.updatedAt));
          if (p.updatedAt >= weekStart) thisWeek++;
        }

        /** @type {boolean[]} */
        const past14 = [];
        let totalDays = 0;
        for (let i = 13; i >= 0; i--) {
          const ts = Date.now() - i * DAY_MS;
          const has = dayKeys.has(dateKey(ts));
          past14.push(has);
          if (has) totalDays++;
        }

        // Streak — count consecutive days ending today (or ending yesterday
        // if user hasn't watched yet today, so yesterday's streak doesn't
        // collapse the moment they wake up).
        let streak = 0;
        const todayHas = dayKeys.has(dateKey(Date.now()));
        const startOffset = todayHas ? 0 : 1;
        for (let i = startOffset; i < 60; i++) {
          const ts = Date.now() - i * DAY_MS;
          if (!dayKeys.has(dateKey(ts))) break;
          streak++;
        }

        setState({ thisWeek, streak, past14, totalDays, loaded: true });
      })
      .catch(() => {
        if (cancelled) return;
        setState((prev) => ({ ...prev, loaded: true }));
      });
    return () => {
      cancelled = true;
    };
  }, [db]);

  return state;
}

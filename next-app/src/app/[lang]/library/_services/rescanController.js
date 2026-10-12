// @ts-nocheck
// Orchestrates the watch-folder reconciliation scan. Pure logic module — no
// React, no DOM, every side effect injected — so the guard chain, throttling,
// root ordering, and failure policy are fully unit-testable under bun:test
// (the repo has no React test harness; this follows the authForm/registerFlow
// convention: logic in a pure module, the hook is just wiring).
//
// Permission contract: this module is read-only and NEVER requests
// permission. Roots that don't probe 'ready' are skipped and surfaced through
// refreshHandles() → the existing availability UI (UnavailableSeriesSection).
// The manual menu path may reauthorize under a user gesture BEFORE calling
// maybeScan — the controller itself must stay gesture-free.
//
//   trigger sources
//     mount ──────────────────────────────┐
//     visibility (tab return) ────────────┤
//     manual (menu; clears failedKeys) ───┤
//     watch (observer, 10s tier) ─────────┼─► guards: FSA ∧ !running ∧ import idle ∧ throttle
//     deferred-retry (65s timer) ─────────┤      │
//     periodic (120s, hook arms it only ──┘      ▼
//       when observer unsupported)         roots (lastSeenAt DESC)
//                                                │ phase 1a: probe; group records of the
//                                                │   same directory (isSameEntry)
//                                                │ phase 1b: diffScanRoot per directory
//                                                │   → onDisk: libraryId → keys found
//                                                ▼
//                                          phase 2, per directory: new videos
//                                                + copies whose row's file is not on disk
//                                                + same paths whose row's folder lost them
//                                                → filter failedKeys (< 3 attempts)
//                                                → markSuperseded → processFiles
//                                                → runImport(record's libraryId, onDisk)
//                                                ▼
//                                          verify vs fresh baseline → attempts++ on miss;
//                                                landed bytes seen before = relinked, else new
//                                                → onScanComplete
//
//   bounce (watch/deferred-retry only): host-deferred / busy / import-busy /
//     throttled → re-arm the 65s timer so the chain outlives the bounce
//   quiet-period deferrals found → arm the 65s timer

import { baselineKey, isGone, isOnDisk, QUIET_PERIOD_MS } from "./rescanService.js";

/** Minimum gap between automatic scans. Manual rescans bypass this. */
export const MIN_SCAN_INTERVAL_MS = 60_000;

/**
 * Tighter gap for event-driven triggers ('watch' from FileSystemObserver and
 * the internal 'deferred-retry') — these fire only when something actually
 * changed, so the coarse 60s throttle would defeat their purpose. The
 * 'periodic' fallback rides this tier too: its ticks are already self-spaced
 * at PERIODIC_FALLBACK_MS, so the coarse throttle would add nothing.
 */
export const WATCH_MIN_INTERVAL_MS = 10_000;

/**
 * Fallback cadence for browsers without FileSystemObserver: useAutoRescan
 * arms an interval at this rate while the page is visible, and each tick
 * calls maybeScan({trigger: "periodic"}). Nothing event-driven fires there,
 * so this is what keeps a long-lived tab converging on disk state.
 */
export const PERIODIC_FALLBACK_MS = 120_000;

/**
 * When a scan defers still-in-quiet-period files, retry once after the guard
 * window (+ slack) so a file that finished writing while the page stays open
 * gets imported without waiting for the next tab-return.
 */
export const DEFERRED_RETRY_DELAY_MS = QUIET_PERIOD_MS + 5_000;

/**
 * How long yieldToManual waits for an in-flight scan to acknowledge the
 * cancel. Bounded so a hung dandanplay call can't block the user's manual
 * "+ add folder" action; the residual overlap window is accepted (the manual
 * runImport re-snapshots priorSeasons on entry).
 */
export const YIELD_TIMEOUT_MS = 5_000;

/**
 * Per-session ceiling on verified import failures for a single entry key.
 * A failed cluster leaves no row behind, so every retry re-reads the 16MB
 * hash prefix and re-hits dandanplay from scratch. Three attempts give a
 * transient failure (network blip, briefly-busy volume) two self-heal
 * windows, while pinning the waste for a permanently bad file at two extra
 * attempts per session. A manual rescan resets the counters.
 */
export const MAX_IMPORT_ATTEMPTS = 3;

/**
 * @param {{
 *   isFsaSupported: () => boolean,
 *   listRoots: () => Promise<any[]>,
 *   probeRoot: (handle: any) => Promise<string>,
 *   isSameEntry: (a: any, b: any) => Promise<boolean>,
 *   buildBaseline: () => Promise<import('./rescanService.js').Baseline>,
 *   diffScanRoot: (p: {handle: any, baseline: any, now: number, libraryIds: Set<string>}) => Promise<any>,
 *   markSuperseded: (candidates: any[], now: number, libraryIds: Set<string>) => Promise<void>,
 *   processFiles: (files: File[], opts: {pathMap: Map<File, string>}) => {files: any[]},
 *   runImport: (p: {items: any[], libraryId: string, onDisk: Map<string, Set<string>>}) => Promise<void>,
 *   getImportStatus: () => string,
 *   onBeforeSilentRun: () => void,
 *   onScanComplete: (result: any) => void,
 *   refreshHandles: () => Promise<void>,
 *   now: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   shouldDefer?: () => boolean,
 * }} deps
 */
export function createRescanController(deps) {
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;

  let running = false;
  let currentRun = null;
  let cancelRequested = false;
  let lastScanAt = 0;
  let lastResult = null;
  let retryTimer = null;
  let disposed = false;
  /**
   * Session-scoped attempt counts for import-failed entries (D7): entry key →
   * verified-failure count. Keys at or past MAX_IMPORT_ATTEMPTS are skipped
   * until a manual rescan clears the map. failedCount / failedKeyCount report
   * only those given-up keys — the UI reads the number as "abandoned", not
   * "has ever failed".
   */
  const failedKeys = new Map();

  /**
   * Arm a single pending retry for quiet-period-deferred files. One at a
   * time — a retry that still defers re-arms itself via its own result, and
   * a watch/deferred-retry trigger bounced off a guard re-arms on the way
   * out (see maybeScan) so the chain survives its consumed timer.
   */
  function armDeferredRetry() {
    if (retryTimer !== null || disposed) return;
    retryTimer = setTimer(() => {
      retryTimer = null;
      if (!disposed) void maybeScan({ trigger: "deferred-retry" });
    }, DEFERRED_RETRY_DELAY_MS);
  }

  const entryKey = (entry) =>
    baselineKey(entry.relPath, entry.file?.size ?? 0);

  /** Number of keys that exhausted MAX_IMPORT_ATTEMPTS (the given-up set). */
  function exhaustedKeyCount() {
    let n = 0;
    for (const attempts of failedKeys.values()) {
      if (attempts >= MAX_IMPORT_ATTEMPTS) n++;
    }
    return n;
  }

  /**
   * Check the scan's import attempts against a fresh baseline.
   *
   * An ordinary entry landed when its path is now known — as a row's recorded
   * path or as a listed copy. A takeover landed when the row holding its
   * bytes now points at a file that is on disk: usually the takeover itself,
   * or, when several copies raced for one row, whichever won (the rest then
   * correctly sit in the row's copies). Whatever did not land takes one more
   * strike on its attempt counter; whatever did has its strikes cleared.
   *
   * Landed entries whose bytes the library held before this scan are
   * relinks (moved, renamed, another copy); the rest are new, counted per
   * row so that two paths of one new file are one new episode.
   *
   * @param {Array<{ key: string, takeover: boolean }>} attempted
   * @param {{ ids?: Set<string> }} before  the baseline the scan started from
   * @param {Map<string, Set<string>>} onDisk  what this pass found, per library
   * @returns {Promise<{ newCount: number, relinkedCount: number }>}
   */
  async function settleAttempts(attempted, before, onDisk) {
    if (!attempted.length) return { newCount: 0, relinkedCount: 0 };
    const after = await deps.buildBaseline();
    const newIds = new Set();
    let relinkedCount = 0;
    for (const { key, takeover } of attempted) {
      const row = after.rowOf?.get(key);
      const landed = takeover
        ? row !== undefined && isOnDisk(onDisk, row, row.size)
        : after.keys.has(key) || Boolean(after.copyKeys?.has(key));
      if (!landed) {
        failedKeys.set(key, (failedKeys.get(key) ?? 0) + 1);
        continue;
      }
      failedKeys.delete(key);
      if (row && before.ids?.has(row.id)) relinkedCount++;
      else newIds.add(row?.id ?? key);
    }
    return { newCount: newIds.size, relinkedCount };
  }

  /** The probed group whose directory is the same entry as `handle`, if any. */
  async function findGroup(groups, handle) {
    for (const group of groups) {
      try {
        if (await deps.isSameEntry(group.rootRecord.handle, handle)) return group;
      } catch {
        // isSameEntry unsupported/failed → conservatively treat as different.
      }
    }
    return null;
  }

  async function doScan(trigger) {
    if (trigger === "manual") failedKeys.clear();

    const roots = await deps.listRoots();
    if (!roots.length) return { outcome: "no-roots", trigger };

    lastScanAt = deps.now();

    const sorted = [...roots].sort(
      (a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0),
    );
    const baseline = await deps.buildBaseline();

    let skippedRoots = 0;
    let deferredCount = 0;

    // Phase 1a — probe every root, and group records that point at the same
    // directory (a folder added more than once). Each group is read once,
    // under its freshest record, and all of its libraryIds share what was
    // found there.
    const groups = [];
    for (const rootRecord of sorted) {
      if (cancelRequested) break;
      try {
        const status = await deps.probeRoot(rootRecord.handle);
        if (status !== "ready") {
          skippedRoots++;
          continue;
        }
        const group = await findGroup(groups, rootRecord.handle);
        if (group) group.libraryIds.add(rootRecord.libraryId);
        else groups.push({ rootRecord, libraryIds: new Set([rootRecord.libraryId]) });
      } catch {
        // Per-root isolation: an unplugged volume / revoked grant mid-scan
        // must neither kill the pass nor log (the /library e2e specs assert
        // ZERO console errors). Surfaced via refreshHandles below instead.
        skippedRoots++;
      }
    }

    // Phase 1b — read every directory before importing anything. Whether a
    // known file's recorded location still holds it decides between a second
    // copy and a moved file, and the two can sit under different roots.
    const scanned = [];
    /** @type {Map<string, Set<string>>} */
    const onDisk = new Map();
    for (const group of groups) {
      if (cancelRequested) break;
      try {
        const diff = await deps.diffScanRoot({
          handle: group.rootRecord.handle,
          baseline,
          now: deps.now(),
          libraryIds: group.libraryIds,
        });
        deferredCount += diff.deferredCount;
        const seen = diff.seenKeys ?? new Set();
        for (const libraryId of group.libraryIds) onDisk.set(libraryId, seen);
        scanned.push({ ...group, diff });
      } catch {
        skippedRoots++;
      }
    }

    // Phase 2 — import, folder by folder.
    const attempted = [];
    let silentRunStarted = false;
    for (const { rootRecord, libraryIds, diff } of scanned) {
      if (cancelRequested) break;
      try {
        const takeovers = new Set([
          // A listed copy takes over unless the row's recorded file is known
          // to be on disk. An unread root counts as not there, so a copy can
          // stand in while the original's drive is unplugged.
          ...(diff.copyHits ?? [])
            .filter((hit) => !isOnDisk(onDisk, hit.row, hit.row.size))
            .map((hit) => hit.entry),
          // The same path under another folder takes over only once that
          // folder was read and no longer holds the file. The global baseline
          // already counts these as known; acting on "unread" here would
          // re-hash every folder still registered under a stale record.
          ...(diff.foreignHits ?? [])
            .filter((hit) => hit.owners.every((row) => isGone(onDisk, row, row.size)))
            .map((hit) => hit.entry),
        ]);
        const fresh = [...diff.newVideos, ...takeovers].filter(
          (v) => (failedKeys.get(entryKey(v)) ?? 0) < MAX_IMPORT_ATTEMPTS,
        );
        if (!fresh.length) continue;
        if (cancelRequested) break;

        if (!silentRunStarted) {
          deps.onBeforeSilentRun();
          silentRunStarted = true;
        }
        if (diff.supersededCandidates.length) {
          await deps.markSuperseded(diff.supersededCandidates, deps.now(), libraryIds);
        }

        const entries = [...fresh, ...diff.subtitles];
        const pathMap = new Map(entries.map((e) => [e.file, e.relPath]));
        const { files: items } = deps.processFiles(
          entries.map((e) => e.file),
          { pathMap },
        );
        await deps.runImport({ items, libraryId: rootRecord.libraryId, onDisk });
        attempted.push(
          ...fresh.map((v) => ({ key: entryKey(v), takeover: takeovers.has(v) })),
        );
      } catch {
        // Same isolation as phase 1: a root failing mid-import is a skipped
        // root, not a failed scan.
        skippedRoots++;
      }
    }

    const { newCount, relinkedCount } = await settleAttempts(attempted, baseline, onDisk);

    if (skippedRoots > 0) {
      try {
        await deps.refreshHandles();
      } catch {
        // refresh is best-effort availability signaling
      }
    }

    const result = {
      outcome: "scanned",
      trigger,
      newCount,
      relinkedCount,
      deferredCount,
      skippedRoots,
      failedCount: exhaustedKeyCount(),
    };
    if (deferredCount > 0 && trigger !== "manual") armDeferredRetry();
    lastResult = result;
    try {
      deps.onScanComplete(result);
    } catch {
      // completion callback must never break the scan contract
    }
    return result;
  }

  /**
   * Run one guarded scan. Never throws; never prompts; silently no-ops when
   * any guard fails (the e2e sandbox — zero roots, no FSA — relies on this).
   *
   * Bounce recovery: a watch or deferred-retry trigger that a guard turns
   * away re-arms the retry timer before returning. Both are one-shot — the
   * deferred-retry timer is already consumed when it fires, and a watch
   * event for a file that just finished writing has no follow-up event
   * coming — so without the re-arm a single bounce kills the chain
   * silently. 'unsupported' never re-arms (missing FSA is permanent);
   * mount/visibility/manual/periodic bounces don't either, since each has a
   * natural next trigger.
   *
   * @param {{ trigger: 'mount'|'visibility'|'manual'|'watch'|'deferred-retry'|'periodic' }} p
   */
  async function maybeScan({ trigger }) {
    const rearmsOnBounce = trigger === "watch" || trigger === "deferred-retry";
    if (!deps.isFsaSupported()) return { outcome: "unsupported", trigger };
    // Host veto (optional dep): e.g. the player page defers while a video is
    // actively playing so hash workers never compete with decode.
    if (deps.shouldDefer?.()) {
      if (rearmsOnBounce) armDeferredRetry();
      return { outcome: "host-deferred", trigger };
    }
    if (running) {
      if (rearmsOnBounce) armDeferredRetry();
      return { outcome: "busy", trigger };
    }
    if (deps.getImportStatus() === "running") {
      if (rearmsOnBounce) armDeferredRetry();
      return { outcome: "import-busy", trigger };
    }
    const minInterval =
      trigger === "watch" ||
      trigger === "deferred-retry" ||
      trigger === "periodic"
        ? WATCH_MIN_INTERVAL_MS
        : MIN_SCAN_INTERVAL_MS;
    if (trigger !== "manual" && deps.now() - lastScanAt < minInterval) {
      if (rearmsOnBounce) armDeferredRetry();
      return { outcome: "throttled", trigger };
    }

    running = true;
    cancelRequested = false;
    currentRun = doScan(trigger).catch((err) => {
      const result = {
        outcome: "error",
        trigger,
        error: String(err?.message ?? err),
      };
      lastResult = result;
      return result;
    });
    try {
      return await currentRun;
    } finally {
      running = false;
      currentRun = null;
    }
  }

  /**
   * Manual-import preemption (D2): request cancel and wait (bounded) for the
   * in-flight scan to exit so handleAddFolder never races the auto scan's
   * runImport on the priorSeasons snapshot.
   */
  async function yieldToManual() {
    if (!currentRun) return;
    cancelRequested = true;
    await Promise.race([currentRun, sleep(YIELD_TIMEOUT_MS)]);
  }

  function getState() {
    return {
      running,
      lastScanAt,
      lastResult,
      failedKeyCount: exhaustedKeyCount(),
      retryArmed: retryTimer !== null,
    };
  }

  /** Cancel timers on host unmount; the controller must not outlive it. */
  function dispose() {
    disposed = true;
    cancelRequested = true;
    if (retryTimer !== null) {
      clearTimer(retryTimer);
      retryTimer = null;
    }
  }

  return { maybeScan, yieldToManual, getState, dispose };
}

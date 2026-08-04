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
//   trigger (mount / visibility / manual)
//     │ guards: FSA ∧ !running ∧ import idle ∧ throttle
//     ▼
//   roots (lastSeenAt DESC, isSameEntry dedupe)
//     │ per root: probe → diffScanRoot → filter failedKeys
//     ▼
//   markSuperseded → processFiles → runImport(root's persisted libraryId)
//     ▼
//   verify vs fresh baseline → newCount / failedKeys → onScanComplete

import { baselineKey } from "./rescanService.js";

/** Minimum gap between automatic scans. Manual rescans bypass this. */
export const MIN_SCAN_INTERVAL_MS = 60_000;

/**
 * How long yieldToManual waits for an in-flight scan to acknowledge the
 * cancel. Bounded so a hung dandanplay call can't block the user's manual
 * "+ add folder" action; the residual overlap window is accepted (the manual
 * runImport re-snapshots priorSeasons on entry).
 */
export const YIELD_TIMEOUT_MS = 5_000;

/**
 * @param {{
 *   isFsaSupported: () => boolean,
 *   listRoots: () => Promise<any[]>,
 *   probeRoot: (handle: any) => Promise<string>,
 *   isSameEntry: (a: any, b: any) => Promise<boolean>,
 *   buildBaseline: () => Promise<{keys: Set<string>, byRelPath: Map<string, any[]>}>,
 *   diffScanRoot: (p: {handle: any, baseline: any, now: number}) => Promise<any>,
 *   markSuperseded: (candidates: any[], now: number) => Promise<void>,
 *   processFiles: (files: File[], opts: {pathMap: Map<File, string>}) => {files: any[]},
 *   runImport: (p: {items: any[], libraryId: string}) => Promise<void>,
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

  let running = false;
  let currentRun = null;
  let cancelRequested = false;
  let lastScanAt = 0;
  let lastResult = null;
  /** Session-scoped skip set for import-failed entries (D7). */
  const failedKeys = new Set();

  const entryKey = (entry) =>
    baselineKey(entry.relPath, entry.file?.size ?? 0);

  async function isDuplicateOf(scannedHandles, handle) {
    for (const seen of scannedHandles) {
      try {
        if (await deps.isSameEntry(seen, handle)) return true;
      } catch {
        // isSameEntry unsupported/failed → conservatively treat as different.
      }
    }
    return false;
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

    const scannedHandles = [];
    const attemptedKeys = [];
    let skippedRoots = 0;
    let deferredCount = 0;
    let silentRunStarted = false;

    for (const rootRecord of sorted) {
      if (cancelRequested) break;
      try {
        const status = await deps.probeRoot(rootRecord.handle);
        if (status !== "ready") {
          skippedRoots++;
          continue;
        }
        if (await isDuplicateOf(scannedHandles, rootRecord.handle)) continue;
        scannedHandles.push(rootRecord.handle);

        const diff = await deps.diffScanRoot({
          handle: rootRecord.handle,
          baseline,
          now: deps.now(),
        });
        deferredCount += diff.deferredCount;

        const fresh = diff.newVideos.filter((v) => !failedKeys.has(entryKey(v)));
        if (!fresh.length) continue;
        if (cancelRequested) break;

        if (!silentRunStarted) {
          deps.onBeforeSilentRun();
          silentRunStarted = true;
        }
        if (diff.supersededCandidates.length) {
          await deps.markSuperseded(diff.supersededCandidates, deps.now());
        }

        const entries = [...fresh, ...diff.subtitles];
        const pathMap = new Map(entries.map((e) => [e.file, e.relPath]));
        const { files: items } = deps.processFiles(
          entries.map((e) => e.file),
          { pathMap },
        );
        await deps.runImport({ items, libraryId: rootRecord.libraryId });
        attemptedKeys.push(...fresh.map(entryKey));
      } catch {
        // Per-root isolation: an unplugged volume / revoked grant mid-scan
        // must neither kill the pass nor log (the /library e2e specs assert
        // ZERO console errors). Surfaced via refreshHandles below instead.
        skippedRoots++;
      }
    }

    // Verify which attempted entries actually landed: anything still missing
    // from a fresh baseline failed inside the pipeline → session skip set.
    let newCount = 0;
    if (attemptedKeys.length) {
      const after = await deps.buildBaseline();
      for (const key of attemptedKeys) {
        if (after.keys.has(key)) newCount++;
        else failedKeys.add(key);
      }
    }

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
      deferredCount,
      skippedRoots,
      failedCount: failedKeys.size,
    };
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
   * @param {{ trigger: 'mount'|'visibility'|'manual' }} p
   */
  async function maybeScan({ trigger }) {
    if (!deps.isFsaSupported()) return { outcome: "unsupported", trigger };
    // Host veto (optional dep): e.g. the player page defers while a video is
    // actively playing so hash workers never compete with decode.
    if (deps.shouldDefer?.()) return { outcome: "host-deferred", trigger };
    if (running) return { outcome: "busy", trigger };
    if (deps.getImportStatus() === "running") {
      return { outcome: "import-busy", trigger };
    }
    if (
      trigger !== "manual" &&
      deps.now() - lastScanAt < MIN_SCAN_INTERVAL_MS
    ) {
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
      failedKeyCount: failedKeys.size,
    };
  }

  return { maybeScan, yieldToManual, getState };
}

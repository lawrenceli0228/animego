"use client";
// @ts-nocheck
// Thin React wiring for the watch-folder reconciliation scan. ALL decision
// logic (guard chain, throttle, ordering, failure policy) lives in the pure
// controller (_services/rescanController.js) where bun:test can reach it —
// this hook only owns the two DOM-bound triggers:
//
//   1. mount    — once, after useFileHandles finishes its read-only probe
//   2. visible  — document visibilitychange back to 'visible'
//
// Permission contract: never calls requestPermission (no gesture here). The
// controller re-probes every root on every scan, so a grant auto-revoked
// while the tab was backgrounded ("Allow this time") degrades to a skipped
// root + availability refresh instead of a throw.

import { useCallback, useEffect, useRef, useState } from "react";
import { isFsaSupported } from "@/lib/library/handles/fsaFeatureCheck.js";
import { probeRootStatus } from "@/lib/library/handles/probeRoot.js";
import { makeFileHandleStore } from "@/lib/library/handles/fileHandleStore.js";
import { createRescanController } from "../_services/rescanController.js";
import { createFolderWatcher } from "../_services/folderWatcher.js";
import {
  buildBaseline,
  diffScanRoot,
  markSuperseded,
} from "../_services/rescanService.js";

/**
 * @param {{
 *   db: import('dexie').Dexie,
 *   handlesStatus: string,
 *   importStatus: string,
 *   runImport: (p: {items: any[], libraryId: string}) => Promise<void>,
 *   processFiles: (files: File[], opts: any) => {files: any[]},
 *   refreshHandles: () => Promise<void>,
 *   onBeforeSilentRun: () => void,
 *   onScanComplete: (result: any) => void,
 *   enabled?: boolean,
 *   triggers?: { mount?: boolean, visibility?: boolean },
 *   shouldDefer?: () => boolean,
 * }} params
 *
 * `triggers` picks which triggers this host wires ({mount, visibility,
 * watch}, all default true — /library uses all, the player skips mount).
 * `watch` is the FileSystemObserver live watch (Chrome/Edge 133+ desktop):
 * a progressive enhancement over the reconciliation scans, never a
 * replacement — observation only lives while the page is open.
 * `shouldDefer` is a host veto evaluated inside the controller's guard chain
 * (e.g. "video is playing"); `enabled` gates the whole hook (e.g. player
 * drop-mode has no library context to scan for).
 */
export function useAutoRescan({
  db,
  handlesStatus,
  importStatus,
  runImport,
  processFiles,
  refreshHandles,
  onBeforeSilentRun,
  onScanComplete,
  enabled = true,
  triggers = {},
  shouldDefer,
}) {
  const wantMount = triggers.mount !== false;
  const wantVisibility = triggers.visibility !== false;
  const wantWatch = triggers.watch !== false;
  const [scanning, setScanning] = useState(false);
  const [lastResult, setLastResult] = useState(null);

  // The controller is created once; latest React values flow in via refs so
  // its injected deps never go stale.
  const latest = useRef({});
  latest.current = {
    importStatus,
    runImport,
    processFiles,
    refreshHandles,
    onBeforeSilentRun,
    onScanComplete,
    shouldDefer,
  };

  const controllerRef = useRef(null);
  const getController = useCallback(() => {
    if (!controllerRef.current) {
      const store = makeFileHandleStore(db);
      controllerRef.current = createRescanController({
        isFsaSupported,
        listRoots: () => store.listRoots(),
        probeRoot: (handle) => probeRootStatus(handle),
        isSameEntry: async (a, b) =>
          typeof a?.isSameEntry === "function" ? a.isSameEntry(b) : false,
        buildBaseline: () => buildBaseline(db),
        diffScanRoot,
        markSuperseded: (candidates, now) => markSuperseded(db, candidates, now),
        processFiles: (files, opts) => latest.current.processFiles(files, opts),
        runImport: (p) => latest.current.runImport(p),
        getImportStatus: () => latest.current.importStatus,
        onBeforeSilentRun: () => latest.current.onBeforeSilentRun?.(),
        onScanComplete: (result) => {
          setLastResult(result);
          latest.current.onScanComplete?.(result);
        },
        refreshHandles: () =>
          Promise.resolve(latest.current.refreshHandles?.()),
        now: () => Date.now(),
        shouldDefer: () => Boolean(latest.current.shouldDefer?.()),
      });
    }
    return controllerRef.current;
  }, [db]);

  const scan = useCallback(
    async (trigger) => {
      const controller = getController();
      setScanning(true);
      try {
        return await controller.maybeScan({ trigger });
      } finally {
        setScanning(false);
      }
    },
    [getController],
  );

  // Mount trigger: fire once, after the read-only handle probe completes
  // ('ready' or 'denied'); 'unsupported' never fires (controller would no-op
  // anyway) and the e2e sandbox (zero fileHandles rows) resolves to a silent
  // 'no-roots' outcome with zero state changes.
  const mountFiredRef = useRef(false);
  useEffect(() => {
    if (!enabled || !wantMount) return;
    if (mountFiredRef.current) return;
    if (handlesStatus !== "ready" && handlesStatus !== "denied") return;
    mountFiredRef.current = true;
    void scan("mount");
  }, [enabled, wantMount, handlesStatus, scan]);

  // Visibility trigger: "downloaded in another window, tabbed back".
  useEffect(() => {
    if (!enabled || !wantVisibility) return;
    const onVisibility = () => {
      if (document.visibilityState === "visible") void scan("visibility");
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [enabled, wantVisibility, scan]);

  // Live watch (PR-3): observe every 'ready' root while the page is open.
  // Events are hints — the action is always the same diff scan ('watch'
  // trigger, tighter throttle). 'errored' records (root deleted, grant
  // revoked) route into the availability re-probe instead. Keyed on
  // handlesStatus so a reauthorize (denied → ready) re-arms observation.
  useEffect(() => {
    if (!enabled || !wantWatch) return;
    if (handlesStatus !== "ready") return;
    const watcher = createFolderWatcher({
      onChange: () => void scan("watch"),
      onRootError: () =>
        void Promise.resolve(latest.current.refreshHandles?.()).catch(() => {}),
    });
    if (!watcher.supported) return;

    let cancelled = false;
    (async () => {
      try {
        const store = makeFileHandleStore(db);
        const roots = await store.listRoots();
        for (const record of roots) {
          if (cancelled) return;
          const status = await probeRootStatus(record.handle);
          if (status === "ready") await watcher.observe(record.handle);
        }
      } catch {
        // Watch setup is best-effort; reconciliation scans remain the truth.
      }
    })();

    return () => {
      cancelled = true;
      watcher.disconnect();
    };
  }, [enabled, wantWatch, handlesStatus, db, scan]);

  // The controller owns a deferred-retry timer; kill it with the host.
  useEffect(() => {
    return () => {
      controllerRef.current?.dispose?.();
    };
  }, []);

  /** Gesture-path rescan from the overflow menu; bypasses the throttle. */
  const manualRescan = useCallback(() => scan("manual"), [scan]);

  /** D2 preemption:手动导入前 cancel 在飞扫描并等其退出(有界)。 */
  const yieldToManual = useCallback(async () => {
    if (controllerRef.current) await controllerRef.current.yieldToManual();
  }, []);

  return { scanning, lastResult, manualRescan, yieldToManual };
}

export default useAutoRescan;

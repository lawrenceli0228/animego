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
 * }} params
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
}) {
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
    if (mountFiredRef.current) return;
    if (handlesStatus !== "ready" && handlesStatus !== "denied") return;
    mountFiredRef.current = true;
    void scan("mount");
  }, [handlesStatus, scan]);

  // Visibility trigger: "downloaded in another window, tabbed back".
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") void scan("visibility");
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [scan]);

  /** Gesture-path rescan from the overflow menu; bypasses the throttle. */
  const manualRescan = useCallback(() => scan("manual"), [scan]);

  /** D2 preemption:手动导入前 cancel 在飞扫描并等其退出(有界)。 */
  const yieldToManual = useCallback(async () => {
    if (controllerRef.current) await controllerRef.current.yieldToManual();
  }, []);

  return { scanning, lastResult, manualRescan, yieldToManual };
}

export default useAutoRescan;

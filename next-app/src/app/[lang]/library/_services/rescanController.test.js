import { describe, expect, test } from "bun:test";
import {
  createRescanController,
  MAX_IMPORT_ATTEMPTS,
  MIN_SCAN_INTERVAL_MS,
  PERIODIC_FALLBACK_MS,
  WATCH_MIN_INTERVAL_MS,
} from "./rescanController.js";
import { baselineKey } from "./rescanService.js";

// ---- harness --------------------------------------------------------------

const NOW = 1_800_000_000_000;

function video(relPath, size = 100) {
  return { file: { size, lastModified: 0 }, relPath, kind: "video" };
}

function emptyDiff() {
  return {
    newVideos: [],
    subtitles: [],
    supersededCandidates: [],
    deferredCount: 0,
    seenRelPaths: new Set(),
  };
}

/**
 * Build a controller with fully-faked deps. Every fake records its calls.
 * `overrides` replaces individual deps; `opts.clock` starts the fake clock.
 */
function harness(overrides = {}, { clock = NOW } = {}) {
  const calls = {
    listRoots: 0,
    buildBaseline: 0,
    probes: [],
    diffs: [],
    imports: [],
    superseded: [],
    beforeSilent: 0,
    complete: [],
    refresh: 0,
  };
  let time = clock;
  const deps = {
    isFsaSupported: () => true,
    listRoots: async () => {
      calls.listRoots++;
      return [];
    },
    probeRoot: async () => {
      calls.probes.push(1);
      return "ready";
    },
    isSameEntry: async () => false,
    buildBaseline: async () => {
      calls.buildBaseline++;
      return { keys: new Set(), byRelPath: new Map() };
    },
    diffScanRoot: async ({ handle }) => {
      calls.diffs.push(handle);
      return emptyDiff();
    },
    markSuperseded: async (candidates) => {
      calls.superseded.push(candidates);
    },
    processFiles: (files, { pathMap }) => ({
      files: files.map((f) => ({ file: f, relativePath: pathMap.get(f) })),
    }),
    runImport: async ({ items, libraryId }) => {
      calls.imports.push({ items, libraryId });
    },
    getImportStatus: () => "idle",
    onBeforeSilentRun: () => {
      calls.beforeSilent++;
    },
    onScanComplete: (result) => {
      calls.complete.push(result);
    },
    refreshHandles: async () => {
      calls.refresh++;
    },
    now: () => time,
    sleep: async () => {},
    ...overrides,
  };
  const controller = createRescanController(deps);
  return { controller, calls, advance: (ms) => (time += ms) };
}

function root(libraryId, lastSeenAt, handle = {}) {
  return { id: `rec-${libraryId}`, libraryId, lastSeenAt, handle };
}

// ---- guard chain ----------------------------------------------------------

describe("createRescanController guards", () => {
  test("FSA unsupported: total no-op, not even listRoots", async () => {
    const { controller, calls } = harness({ isFsaSupported: () => false });
    const result = await controller.maybeScan({ trigger: "mount" });
    expect(result.outcome).toBe("unsupported");
    expect(calls.listRoots).toBe(0);
  });

  test("zero roots: no baseline read, no side effects", async () => {
    const { controller, calls } = harness();
    const result = await controller.maybeScan({ trigger: "mount" });
    expect(result.outcome).toBe("no-roots");
    expect(calls.buildBaseline).toBe(0);
    expect(calls.beforeSilent).toBe(0);
    expect(calls.complete).toHaveLength(0);
  });

  test("host veto (shouldDefer) blocks the scan before any work", async () => {
    let defer = true;
    const { controller, calls } = harness({
      shouldDefer: () => defer,
      listRoots: async () => [root("lib1", 1)],
    });
    const vetoed = await controller.maybeScan({ trigger: "visibility" });
    expect(vetoed.outcome).toBe("host-deferred");
    expect(calls.listRoots).toBe(0);
    defer = false;
    expect((await controller.maybeScan({ trigger: "visibility" })).outcome).toBe("scanned");
  });

  test("manual import in flight blocks the scan", async () => {
    const { controller, calls } = harness({ getImportStatus: () => "running" });
    const result = await controller.maybeScan({ trigger: "visibility" });
    expect(result.outcome).toBe("import-busy");
    expect(calls.listRoots).toBe(0);
  });

  test("throttle: second auto trigger inside the interval is dropped, manual bypasses", async () => {
    const { controller, advance } = harness({
      listRoots: async () => [root("lib1", 1)],
    });
    expect((await controller.maybeScan({ trigger: "mount" })).outcome).toBe("scanned");
    advance(MIN_SCAN_INTERVAL_MS - 1000);
    expect((await controller.maybeScan({ trigger: "visibility" })).outcome).toBe("throttled");
    expect((await controller.maybeScan({ trigger: "manual" })).outcome).toBe("scanned");
  });

  test("re-entrancy: concurrent maybeScan reports busy", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const { controller } = harness({
      listRoots: async () => [root("lib1", 1)],
      diffScanRoot: async () => {
        await gate;
        return emptyDiff();
      },
    });
    const first = controller.maybeScan({ trigger: "mount" });
    const second = await controller.maybeScan({ trigger: "visibility" });
    expect(second.outcome).toBe("busy");
    release();
    expect((await first).outcome).toBe("scanned");
  });
});

// ---- root ordering & dedupe ----------------------------------------------

describe("root ordering and dedupe", () => {
  test("scans lastSeenAt DESC so the freshest record claims new files", async () => {
    const hNew = { tag: "new" };
    const hOld = { tag: "old" };
    const { controller, calls } = harness({
      listRoots: async () => [root("older", 100, hOld), root("newer", 200, hNew)],
      diffScanRoot: async ({ handle }) => {
        calls.diffs.push(handle);
        return { ...emptyDiff(), newVideos: [video(`${handle.tag}/01.mkv`)] };
      },
    });
    await controller.maybeScan({ trigger: "mount" });
    expect(calls.diffs[0].tag).toBe("new");
    expect(calls.imports[0].libraryId).toBe("newer");
  });

  test("duplicate physical directory (isSameEntry) is enumerated once", async () => {
    const { controller, calls } = harness({
      listRoots: async () => [root("a", 200), root("b", 100)],
      isSameEntry: async () => true,
    });
    await controller.maybeScan({ trigger: "mount" });
    expect(calls.diffs).toHaveLength(1);
  });

  test("isSameEntry throwing is treated as different directories", async () => {
    const { controller, calls } = harness({
      listRoots: async () => [root("a", 200), root("b", 100)],
      isSameEntry: async () => {
        throw new Error("unsupported");
      },
    });
    await controller.maybeScan({ trigger: "mount" });
    expect(calls.diffs).toHaveLength(2);
  });
});

// ---- per-root isolation & error surfacing (D5) ----------------------------

describe("per-root isolation", () => {
  test("non-ready root is skipped and availability refresh fires", async () => {
    const { controller, calls } = harness({
      listRoots: async () => [root("dead", 200), root("live", 100)],
      probeRoot: (() => {
        let n = 0;
        return async () => (n++ === 0 ? "disconnected" : "ready");
      })(),
    });
    const result = await controller.maybeScan({ trigger: "mount" });
    expect(result.skippedRoots).toBe(1);
    expect(calls.diffs).toHaveLength(1);
    expect(calls.refresh).toBe(1);
  });

  test("one root throwing mid-diff does not kill the others", async () => {
    const { controller, calls } = harness({
      listRoots: async () => [root("boom", 200), root("ok", 100)],
      diffScanRoot: (() => {
        let n = 0;
        return async () => {
          if (n++ === 0) throw Object.assign(new Error("gone"), { name: "NotFoundError" });
          calls.diffs.push("ok");
          return emptyDiff();
        };
      })(),
    });
    const result = await controller.maybeScan({ trigger: "mount" });
    expect(result.outcome).toBe("scanned");
    expect(result.skippedRoots).toBe(1);
    expect(calls.diffs).toEqual(["ok"]);
  });
});

// ---- import flow ----------------------------------------------------------

describe("import flow", () => {
  test("zero new files: silent no-op — no dismissal, no import, no supersede", async () => {
    const { controller, calls } = harness({
      listRoots: async () => [root("lib1", 1)],
    });
    const result = await controller.maybeScan({ trigger: "mount" });
    expect(result.outcome).toBe("scanned");
    expect(result.newCount).toBe(0);
    expect(calls.beforeSilent).toBe(0);
    expect(calls.imports).toHaveLength(0);
    expect(calls.superseded).toHaveLength(0);
  });

  test("new files: dismiss-first, supersede, import with the root's persisted libraryId, verified count", async () => {
    const entry = video("Frieren/07.mkv", 700);
    const sub = { file: { size: 10 }, relPath: "Frieren/07.ass", kind: "subtitle" };
    const key = baselineKey("Frieren/07.mkv", 700);
    let baselineCalls = 0;
    const { controller, calls } = harness({
      listRoots: async () => [root("lib-persisted", 1)],
      buildBaseline: async () => {
        baselineCalls++;
        // First call: pre-scan baseline (empty). Second: post-import verify.
        return baselineCalls === 1
          ? { keys: new Set(), byRelPath: new Map() }
          : { keys: new Set([key]), byRelPath: new Map() };
      },
      diffScanRoot: async () => ({
        ...emptyDiff(),
        newVideos: [entry],
        subtitles: [sub],
        supersededCandidates: [{ relPath: "Frieren/07.mkv", ids: ["old"] }],
      }),
    });
    const result = await controller.maybeScan({ trigger: "mount" });
    expect(calls.beforeSilent).toBe(1);
    expect(calls.superseded).toHaveLength(1);
    expect(calls.imports).toHaveLength(1);
    expect(calls.imports[0].libraryId).toBe("lib-persisted");
    // videos + subtitle sidecars both flow into processFiles
    expect(calls.imports[0].items).toHaveLength(2);
    expect(result.newCount).toBe(1);
    expect(calls.complete[0].newCount).toBe(1);
  });

  /**
   * Harness where one key always fails: the diff reports it as new on every
   * scan and the post-import verify baseline never contains it.
   */
  function failingKeyHarness() {
    return harness({
      listRoots: async () => [root("lib1", 1)],
      diffScanRoot: async () => ({
        ...emptyDiff(),
        newVideos: [video("bad/01.mkv", 50)],
      }),
    });
  }

  test("one failed import is retried on the next scan, not yet given up (D7)", async () => {
    const { controller, calls, advance } = failingKeyHarness();

    // 1st auto scan: attempts the import, verify fails → strike one of three.
    const first = await controller.maybeScan({ trigger: "mount" });
    expect(first.newCount).toBe(0);
    expect(calls.imports).toHaveLength(1);
    // failedCount / failedKeyCount mean "given up at the attempt cap", not
    // "has ever failed" — a single strike still gets its self-heal window.
    expect(first.failedCount).toBe(0);
    expect(controller.getState().failedKeyCount).toBe(0);

    // 2nd auto scan (past the throttle): the key is retried, not skipped.
    advance(MIN_SCAN_INTERVAL_MS + 1000);
    await controller.maybeScan({ trigger: "visibility" });
    expect(calls.imports).toHaveLength(2);
  });

  test("a key failing MAX_IMPORT_ATTEMPTS times is dropped: no further hash/dandanplay rounds (D7)", async () => {
    const { controller, calls, advance } = failingKeyHarness();

    let last;
    for (let i = 0; i < MAX_IMPORT_ATTEMPTS; i++) {
      last = await controller.maybeScan({ trigger: "visibility" });
      advance(MIN_SCAN_INTERVAL_MS + 1000);
    }
    expect(calls.imports).toHaveLength(MAX_IMPORT_ATTEMPTS);
    // Exactly at the cap the key flips into the given-up bucket.
    expect(last.failedCount).toBe(1);
    expect(controller.getState().failedKeyCount).toBe(1);

    // Next scan still runs, but the exhausted key never re-enters the
    // pipeline — the repeat 16MB hash / dandanplay storm stops here.
    const next = await controller.maybeScan({ trigger: "visibility" });
    expect(next.outcome).toBe("scanned");
    expect(calls.imports).toHaveLength(MAX_IMPORT_ATTEMPTS);
  });

  test("manual rescan clears exhausted keys and force-retries them (D7)", async () => {
    const { controller, calls, advance } = failingKeyHarness();

    for (let i = 0; i < MAX_IMPORT_ATTEMPTS; i++) {
      await controller.maybeScan({ trigger: "visibility" });
      advance(MIN_SCAN_INTERVAL_MS + 1000);
    }
    expect(calls.imports).toHaveLength(MAX_IMPORT_ATTEMPTS);
    expect(controller.getState().failedKeyCount).toBe(1);

    const manual = await controller.maybeScan({ trigger: "manual" });
    expect(calls.imports).toHaveLength(MAX_IMPORT_ATTEMPTS + 1);
    // clear() wiped the counters, so the fresh failure is strike one again.
    expect(manual.failedCount).toBe(0);
    expect(controller.getState().failedKeyCount).toBe(0);
  });

  test("deferred (quiet-period) files are reported but not imported", async () => {
    const { controller, calls } = harness({
      listRoots: async () => [root("lib1", 1)],
      diffScanRoot: async () => ({ ...emptyDiff(), deferredCount: 2 }),
    });
    const result = await controller.maybeScan({ trigger: "mount" });
    expect(result.deferredCount).toBe(2);
    expect(calls.imports).toHaveLength(0);
  });
});

// ---- watch trigger + deferred retry (PR-3) --------------------------------

describe("watch trigger and deferred retry", () => {
  function timedHarness(overrides = {}) {
    const timers = [];
    const base = harness({
      listRoots: async () => [root("lib1", 1)],
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clearTimer: () => {},
      ...overrides,
    });
    return { ...base, timers };
  }

  test("'watch' trigger uses the tighter interval, not the 60s throttle", async () => {
    const { controller, advance } = timedHarness();
    expect((await controller.maybeScan({ trigger: "watch" })).outcome).toBe("scanned");
    advance(WATCH_MIN_INTERVAL_MS - 1000);
    expect((await controller.maybeScan({ trigger: "watch" })).outcome).toBe("throttled");
    advance(2000);
    expect((await controller.maybeScan({ trigger: "watch" })).outcome).toBe("scanned");
  });

  test("'periodic' fallback trigger rides the watch tier, not the 60s throttle", async () => {
    // Sanity: periodic ticks are self-spaced far beyond even the coarse
    // interval — the tight tier only matters when they interleave with
    // other triggers' scans.
    expect(PERIODIC_FALLBACK_MS).toBeGreaterThan(MIN_SCAN_INTERVAL_MS);
    const { controller, advance } = timedHarness();
    expect((await controller.maybeScan({ trigger: "periodic" })).outcome).toBe("scanned");
    advance(WATCH_MIN_INTERVAL_MS - 1000);
    expect((await controller.maybeScan({ trigger: "periodic" })).outcome).toBe("throttled");
    advance(6000); // 15s since the last scan: past 10s, well under 60s
    expect((await controller.maybeScan({ trigger: "periodic" })).outcome).toBe("scanned");
  });

  test("'deferred-retry' bounced by the host veto re-arms instead of dying", async () => {
    const { controller, timers } = timedHarness({ shouldDefer: () => true });
    const result = await controller.maybeScan({ trigger: "deferred-retry" });
    expect(result.outcome).toBe("host-deferred");
    expect(controller.getState().retryArmed).toBe(true);
    expect(timers).toHaveLength(1);
  });

  test("'watch' bounced by a running manual import re-arms", async () => {
    const { controller } = timedHarness({ getImportStatus: () => "running" });
    const result = await controller.maybeScan({ trigger: "watch" });
    expect(result.outcome).toBe("import-busy");
    expect(controller.getState().retryArmed).toBe(true);
  });

  test("'watch' bounced by the throttle re-arms", async () => {
    const { controller, advance } = timedHarness();
    await controller.maybeScan({ trigger: "mount" });
    advance(WATCH_MIN_INTERVAL_MS - 1000);
    const result = await controller.maybeScan({ trigger: "watch" });
    expect(result.outcome).toBe("throttled");
    expect(controller.getState().retryArmed).toBe(true);
  });

  test("'mount' bounced by the throttle does NOT re-arm (natural follow-ups exist)", async () => {
    const { controller, advance } = timedHarness();
    await controller.maybeScan({ trigger: "mount" });
    advance(1000);
    const result = await controller.maybeScan({ trigger: "mount" });
    expect(result.outcome).toBe("throttled");
    expect(controller.getState().retryArmed).toBe(false);
  });

  test("quiet-period deferral arms exactly one retry, which rescans", async () => {
    let scans = 0;
    const { controller, timers, advance } = timedHarness({
      diffScanRoot: async () => {
        scans++;
        return { ...emptyDiff(), deferredCount: 1 };
      },
    });
    await controller.maybeScan({ trigger: "watch" });
    await controller.maybeScan({ trigger: "manual" }); // manual defers too but must NOT arm
    expect(timers).toHaveLength(1);
    expect(controller.getState().retryArmed).toBe(true);
    expect(scans).toBe(2);

    advance(WATCH_MIN_INTERVAL_MS + 1000);
    timers[0].fn();
    // Firing the retry runs a real scan (async) — settle it.
    await new Promise((r) => setTimeout(r, 0));
    expect(scans).toBe(3);
  });

  test("no deferral → no retry armed", async () => {
    const { controller, timers } = timedHarness();
    await controller.maybeScan({ trigger: "mount" });
    expect(timers).toHaveLength(0);
    expect(controller.getState().retryArmed).toBe(false);
  });

  test("dispose cancels the pending retry and blocks future scans' timers", async () => {
    let cleared = 0;
    const { controller, timers } = timedHarness({
      clearTimer: () => {
        cleared++;
      },
      diffScanRoot: async () => ({ ...emptyDiff(), deferredCount: 1 }),
    });
    await controller.maybeScan({ trigger: "mount" });
    expect(timers).toHaveLength(1);
    controller.dispose();
    expect(cleared).toBe(1);
    expect(controller.getState().retryArmed).toBe(false);
  });
});

// ---- preemption (D2) ------------------------------------------------------

describe("yieldToManual", () => {
  test("cancels between roots: pending root's import never starts", async () => {
    let releaseFirst;
    const firstImport = new Promise((r) => (releaseFirst = r));
    const { controller, calls } = harness({
      listRoots: async () => [root("a", 200, { t: "a" }), root("b", 100, { t: "b" })],
      diffScanRoot: async ({ handle }) => ({
        ...emptyDiff(),
        newVideos: [video(`${handle.t}/01.mkv`)],
      }),
      runImport: async ({ libraryId }) => {
        calls.imports.push({ libraryId });
        if (calls.imports.length === 1) await firstImport;
      },
    });
    const scan = controller.maybeScan({ trigger: "mount" });
    // Let the scan reach the first (blocking) import.
    await new Promise((r) => setTimeout(r, 0));
    const yielded = controller.yieldToManual();
    releaseFirst();
    await yielded;
    await scan;
    expect(calls.imports).toHaveLength(1);
    expect(calls.imports[0].libraryId).toBe("a");
  });

  test("yieldToManual resolves immediately when nothing is running", async () => {
    const { controller } = harness();
    await controller.yieldToManual();
    expect(controller.getState().running).toBe(false);
  });
});

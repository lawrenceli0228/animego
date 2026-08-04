import { describe, expect, test } from "bun:test";
import {
  baselineKey,
  buildBaseline,
  diffScanRoot,
  QUIET_PERIOD_MS,
} from "./rescanService.js";

// ---- fixtures -------------------------------------------------------------

const NOW = 1_800_000_000_000;

/** Build a File-like stub the way enumerate() yields them. */
function fakeFile({ size = 500 * 1024 * 1024, lastModified = NOW - 3_600_000 } = {}) {
  return { size, lastModified };
}

/** Async generator matching enumerate()'s yield shape. */
function fakeEnumerate(items) {
  return async function* enumerate() {
    for (const item of items) {
      if (item instanceof Error) throw item;
      yield item;
    }
  };
}

function fakeDb(rows) {
  return { fileRefs: { toArray: async () => rows } };
}

// ---- buildBaseline --------------------------------------------------------

describe("buildBaseline", () => {
  test("indexes rows by (relPath,size) key and groups by relPath", async () => {
    const rows = [
      { id: "a", relPath: "Frieren/01.mkv", size: 100 },
      { id: "b", relPath: "Frieren/02.mkv", size: 200 },
    ];
    const baseline = await buildBaseline(fakeDb(rows));
    expect(baseline.keys.has(baselineKey("Frieren/01.mkv", 100))).toBe(true);
    expect(baseline.keys.has(baselineKey("Frieren/02.mkv", 200))).toBe(true);
    expect(baseline.byRelPath.get("Frieren/01.mkv")).toEqual([rows[0]]);
  });

  test("excludes superseded rows and rows without relPath", async () => {
    const rows = [
      { id: "a", relPath: "x/01.mkv", size: 100, supersededAt: NOW - 1 },
      { id: "b", size: 100 },
    ];
    const baseline = await buildBaseline(fakeDb(rows));
    expect(baseline.keys.size).toBe(0);
    expect(baseline.byRelPath.size).toBe(0);
  });
});

// ---- diffScanRoot ---------------------------------------------------------

describe("diffScanRoot", () => {
  test("unseen video is selected as a new entry", async () => {
    const file = fakeFile();
    const baseline = await buildBaseline(fakeDb([]));
    const result = await diffScanRoot({
      handle: {},
      baseline,
      now: NOW,
      enumerate: fakeEnumerate([
        { file, relPath: "Frieren/01.mkv", depth: 1, kind: "video" },
      ]),
    });
    expect(result.newVideos).toHaveLength(1);
    expect(result.newVideos[0].relPath).toBe("Frieren/01.mkv");
    expect(result.deferredCount).toBe(0);
  });

  test("video already in baseline is skipped", async () => {
    const file = fakeFile({ size: 100 });
    const baseline = await buildBaseline(
      fakeDb([{ id: "a", relPath: "Frieren/01.mkv", size: 100 }]),
    );
    const result = await diffScanRoot({
      handle: {},
      baseline,
      now: NOW,
      enumerate: fakeEnumerate([
        { file, relPath: "Frieren/01.mkv", depth: 1, kind: "video" },
      ]),
    });
    expect(result.newVideos).toHaveLength(0);
    expect(result.supersededCandidates).toHaveLength(0);
  });

  test("same relPath with changed size re-imports and marks old rows superseded", async () => {
    const file = fakeFile({ size: 999 });
    const baseline = await buildBaseline(
      fakeDb([{ id: "old-row", relPath: "Frieren/01.mkv", size: 100 }]),
    );
    const result = await diffScanRoot({
      handle: {},
      baseline,
      now: NOW,
      enumerate: fakeEnumerate([
        { file, relPath: "Frieren/01.mkv", depth: 1, kind: "video" },
      ]),
    });
    expect(result.newVideos).toHaveLength(1);
    expect(result.supersededCandidates).toEqual([
      { relPath: "Frieren/01.mkv", ids: ["old-row"] },
    ]);
  });

  test("file modified inside the quiet period is deferred, not selected", async () => {
    const growing = fakeFile({ lastModified: NOW - (QUIET_PERIOD_MS - 1000) });
    const baseline = await buildBaseline(fakeDb([]));
    const result = await diffScanRoot({
      handle: {},
      baseline,
      now: NOW,
      enumerate: fakeEnumerate([
        { file: growing, relPath: "x/01.mkv", depth: 1, kind: "video" },
      ]),
    });
    expect(result.newVideos).toHaveLength(0);
    expect(result.deferredCount).toBe(1);
  });

  test("subtitles never gate newness but are returned for sidecar matching", async () => {
    const baseline = await buildBaseline(fakeDb([]));
    const result = await diffScanRoot({
      handle: {},
      baseline,
      now: NOW,
      enumerate: fakeEnumerate([
        { file: fakeFile(), relPath: "x/01.ass", depth: 1, kind: "subtitle" },
      ]),
    });
    expect(result.newVideos).toHaveLength(0);
    expect(result.subtitles).toHaveLength(1);
  });

  test("seenRelPaths tracks every enumerated video for vanish accounting", async () => {
    const baseline = await buildBaseline(fakeDb([]));
    const result = await diffScanRoot({
      handle: {},
      baseline,
      now: NOW,
      enumerate: fakeEnumerate([
        { file: fakeFile({ size: 1 * 1024 * 1024 }), relPath: "a/01.mkv", depth: 1, kind: "video" },
        { file: fakeFile({ size: 2 * 1024 * 1024 }), relPath: "a/02.mkv", depth: 1, kind: "video" },
      ]),
    });
    expect([...result.seenRelPaths].sort()).toEqual(["a/01.mkv", "a/02.mkv"]);
  });

  test("enumeration failure propagates to the caller (controller isolates per root)", async () => {
    const baseline = await buildBaseline(fakeDb([]));
    const boom = Object.assign(new Error("gone"), { name: "NotFoundError" });
    await expect(
      diffScanRoot({
        handle: {},
        baseline,
        now: NOW,
        enumerate: fakeEnumerate([boom]),
      }),
    ).rejects.toThrow("gone");
  });
});

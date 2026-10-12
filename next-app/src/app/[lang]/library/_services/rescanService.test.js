import { describe, expect, test } from "bun:test";
import {
  baselineKey,
  buildBaseline,
  diffScanRoot,
  FUTURE_SKEW_MS,
  isGone,
  isOnDisk,
  markSuperseded,
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

  test("mtime slightly in the future (NAS clock skew) is still deferred", async () => {
    const skewed = fakeFile({ lastModified: NOW + FUTURE_SKEW_MS / 2 }); // 60s ahead
    const baseline = await buildBaseline(fakeDb([]));
    const result = await diffScanRoot({
      handle: {},
      baseline,
      now: NOW,
      enumerate: fakeEnumerate([
        { file: skewed, relPath: "x/01.mkv", depth: 1, kind: "video" },
      ]),
    });
    expect(result.newVideos).toHaveLength(0);
    expect(result.deferredCount).toBe(1);
  });

  test("mtime far in the future (bad stored timestamp) imports immediately", async () => {
    const stamped = fakeFile({ lastModified: NOW + FUTURE_SKEW_MS + 60_000 }); // 180s ahead
    const baseline = await buildBaseline(fakeDb([]));
    const result = await diffScanRoot({
      handle: {},
      baseline,
      now: NOW,
      enumerate: fakeEnumerate([
        { file: stamped, relPath: "x/01.mkv", depth: 1, kind: "video" },
      ]),
    });
    expect(result.newVideos).toHaveLength(1);
    expect(result.newVideos[0].relPath).toBe("x/01.mkv");
    expect(result.deferredCount).toBe(0);
  });

  test("far-future mtime still runs the superseded path for a same-relPath replacement", async () => {
    const stamped = fakeFile({ size: 999, lastModified: NOW + FUTURE_SKEW_MS + 60_000 });
    const baseline = await buildBaseline(
      fakeDb([{ id: "old-row", relPath: "x/01.mkv", size: 100 }]),
    );
    const result = await diffScanRoot({
      handle: {},
      baseline,
      now: NOW,
      enumerate: fakeEnumerate([
        { file: stamped, relPath: "x/01.mkv", depth: 1, kind: "video" },
      ]),
    });
    expect(result.newVideos).toHaveLength(1);
    expect(result.deferredCount).toBe(0);
    expect(result.supersededCandidates).toEqual([
      { relPath: "x/01.mkv", ids: ["old-row"] },
    ]);
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

// ---- second copies of the same bytes --------------------------------------
//
// A fileRef is keyed by content, so two copies of one file share a row. The
// row used to hold a single path, which made the copy it did not name look
// new on every scan: importing it rewrote the row to that path, and the next
// scan found the other copy instead. The row now lists its other copies.

describe("copies", () => {
  const ROW = {
    id: "row-1",
    libraryId: "lib-1",
    relPath: "Re Zero/S04E09.mkv",
    size: 900,
    copies: [{ libraryId: "lib-1", relPath: "S04E09.mkv" }],
  };
  const ROW_REF = { id: "row-1", libraryId: "lib-1", relPath: "Re Zero/S04E09.mkv", size: 900 };

  test("a row's copies are known keys that resolve to the row", async () => {
    const baseline = await buildBaseline(fakeDb([ROW]));
    expect(baseline.keys.has(baselineKey("S04E09.mkv", 900))).toBe(false);
    expect(baseline.copyKeys.has(baselineKey("S04E09.mkv", 900))).toBe(true);
    expect(baseline.rowOf.get(baselineKey("S04E09.mkv", 900))).toEqual(ROW_REF);
    expect(baseline.rowOf.get(baselineKey("Re Zero/S04E09.mkv", 900))).toEqual(ROW_REF);
  });

  test("a copy listed at another row's recorded path counts as that row's", async () => {
    const other = { id: "row-2", libraryId: "lib-1", relPath: "S04E09.mkv", size: 900 };
    const baseline = await buildBaseline(fakeDb([ROW, other]));
    expect(baseline.copyKeys.has(baselineKey("S04E09.mkv", 900))).toBe(false);
    expect(baseline.rowOf.get(baselineKey("S04E09.mkv", 900)).id).toBe("row-2");
  });

  test("ids covers every row the library holds, superseded ones included", async () => {
    const baseline = await buildBaseline(
      fakeDb([ROW, { id: "old", relPath: "x/01.mkv", size: 1, supersededAt: NOW - 1 }]),
    );
    expect([...baseline.ids].sort()).toEqual(["old", "row-1"]);
    expect(baseline.keys.has(baselineKey("x/01.mkv", 1))).toBe(false);
  });

  test("a superseded row contributes no copy keys", async () => {
    const baseline = await buildBaseline(fakeDb([{ ...ROW, supersededAt: NOW - 1 }]));
    expect(baseline.copyKeys.size).toBe(0);
  });

  test("a path recorded as a copy is a copy hit, never a new video", async () => {
    const baseline = await buildBaseline(fakeDb([ROW]));
    const entry = { file: fakeFile({ size: 900 }), relPath: "S04E09.mkv", depth: 0, kind: "video" };
    const result = await diffScanRoot({
      handle: {},
      baseline,
      now: NOW,
      enumerate: fakeEnumerate([entry]),
    });
    expect(result.newVideos).toHaveLength(0);
    expect(result.copyHits).toEqual([{ entry, row: ROW_REF }]);
  });

  test("a listed copy modified moments ago waits out the quiet period", async () => {
    const baseline = await buildBaseline(fakeDb([ROW]));
    const result = await diffScanRoot({
      handle: {},
      baseline,
      now: NOW,
      enumerate: fakeEnumerate([
        {
          file: fakeFile({ size: 900, lastModified: NOW - 1000 }),
          relPath: "S04E09.mkv",
          depth: 0,
          kind: "video",
        },
      ]),
    });
    expect(result.copyHits).toHaveLength(0);
    expect(result.deferredCount).toBe(1);
  });

  test("seenKeys records every enumerated video, quiet-period ones included", async () => {
    const baseline = await buildBaseline(fakeDb([ROW]));
    const result = await diffScanRoot({
      handle: {},
      baseline,
      now: NOW,
      enumerate: fakeEnumerate([
        { file: fakeFile({ size: 900 }), relPath: "Re Zero/S04E09.mkv", depth: 1, kind: "video" },
        { file: fakeFile({ size: 900 }), relPath: "S04E09.mkv", depth: 0, kind: "video" },
        {
          file: fakeFile({ size: 5, lastModified: NOW - 1000 }),
          relPath: "new/01.mkv",
          depth: 1,
          kind: "video",
        },
        { file: fakeFile({ size: 7 }), relPath: "new/01.ass", depth: 1, kind: "subtitle" },
      ]),
    });
    expect(result.deferredCount).toBe(1);
    expect([...result.seenKeys].sort()).toEqual(
      [
        baselineKey("Re Zero/S04E09.mkv", 900),
        baselineKey("S04E09.mkv", 900),
        baselineKey("new/01.mkv", 5),
      ].sort(),
    );
  });
});

// ---- the folder being scanned -----------------------------------------------
//
// The baseline is global, keyed by (relPath,size): the same relative path in
// two library folders looks like one file. Given the libraries the scanned
// folder is registered under, the diff tells its own rows from other folders'.

describe("which folder a row belongs to", () => {
  const ROW = { id: "row-1", libraryId: "lib-A", relPath: "Show/E01.mkv", size: 100 };
  const entry = { file: fakeFile({ size: 100 }), relPath: "Show/E01.mkv", depth: 1, kind: "video" };

  test("the path a row of this folder records is skipped", async () => {
    const result = await diffScanRoot({
      handle: {},
      baseline: await buildBaseline(fakeDb([ROW])),
      now: NOW,
      libraryIds: new Set(["lib-A"]),
      enumerate: fakeEnumerate([entry]),
    });
    expect(result.foreignHits).toHaveLength(0);
    expect(result.newVideos).toHaveLength(0);
  });

  test("the same path recorded by another folder's row is a foreign hit", async () => {
    const result = await diffScanRoot({
      handle: {},
      baseline: await buildBaseline(fakeDb([ROW])),
      now: NOW,
      libraryIds: new Set(["lib-B"]),
      enumerate: fakeEnumerate([entry]),
    });
    expect(result.foreignHits).toEqual([
      { entry, owners: [{ id: "row-1", libraryId: "lib-A", relPath: "Show/E01.mkv", size: 100 }] },
    ]);
    expect(result.newVideos).toHaveLength(0);
  });

  test("without libraryIds every known path is skipped, as before", async () => {
    const result = await diffScanRoot({
      handle: {},
      baseline: await buildBaseline(fakeDb([ROW])),
      now: NOW,
      enumerate: fakeEnumerate([entry]),
    });
    expect(result.foreignHits).toHaveLength(0);
  });

  test("only this folder's rows are offered as superseded", async () => {
    const result = await diffScanRoot({
      handle: {},
      baseline: await buildBaseline(fakeDb([ROW])),
      now: NOW,
      libraryIds: new Set(["lib-B"]),
      enumerate: fakeEnumerate([{ ...entry, file: fakeFile({ size: 999 }) }]),
    });
    expect(result.newVideos).toHaveLength(1);
    expect(result.supersededCandidates).toEqual([]);
  });
});

// ---- markSuperseded ---------------------------------------------------------

function writableDb(rows) {
  const byId = new Map(rows.map((r) => [r.id, { ...r }]));
  return {
    byId,
    fileRefs: {
      get: async (id) => (byId.has(id) ? { ...byId.get(id) } : undefined),
      update: async (id, patch) => {
        byId.set(id, { ...byId.get(id), ...patch });
      },
    },
  };
}

describe("markSuperseded", () => {
  test("tags a row still at the candidate path in the scanned folder", async () => {
    const db = writableDb([{ id: "r", libraryId: "lib-A", relPath: "x/01.mkv" }]);
    await markSuperseded(db, [{ relPath: "x/01.mkv", ids: ["r"] }], NOW, new Set(["lib-A"]));
    expect(db.byId.get("r").supersededAt).toBe(NOW);
  });

  test("leaves a row that moved since the pass began", async () => {
    const db = writableDb([{ id: "r", libraryId: "lib-A", relPath: "Moved/01.mkv" }]);
    await markSuperseded(db, [{ relPath: "x/01.mkv", ids: ["r"] }], NOW, new Set(["lib-A"]));
    expect(db.byId.get("r").supersededAt).toBeUndefined();
  });

  test("leaves a row that now belongs to another folder", async () => {
    const db = writableDb([{ id: "r", libraryId: "lib-B", relPath: "x/01.mkv" }]);
    await markSuperseded(db, [{ relPath: "x/01.mkv", ids: ["r"] }], NOW, new Set(["lib-A"]));
    expect(db.byId.get("r").supersededAt).toBeUndefined();
  });
});

// ---- isOnDisk / isGone ------------------------------------------------------

describe("isOnDisk and isGone", () => {
  const onDisk = new Map([["lib-A", new Set([baselineKey("x/01.mkv", 5)])]]);

  test("a file found under its library is on disk", () => {
    expect(isOnDisk(onDisk, { libraryId: "lib-A", relPath: "x/01.mkv" }, 5)).toBe(true);
    expect(isGone(onDisk, { libraryId: "lib-A", relPath: "x/01.mkv" }, 5)).toBe(false);
  });

  test("a library that was read without the file has lost it", () => {
    expect(isOnDisk(onDisk, { libraryId: "lib-A", relPath: "x/02.mkv" }, 5)).toBe(false);
    expect(isGone(onDisk, { libraryId: "lib-A", relPath: "x/02.mkv" }, 5)).toBe(true);
  });

  test("a library that was not read is neither", () => {
    expect(isOnDisk(onDisk, { libraryId: "lib-B", relPath: "x/01.mkv" }, 5)).toBe(false);
    expect(isGone(onDisk, { libraryId: "lib-B", relPath: "x/01.mkv" }, 5)).toBe(false);
  });
});

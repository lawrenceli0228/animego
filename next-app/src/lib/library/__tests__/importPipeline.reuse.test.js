import { describe, expect, test } from "bun:test";
import { runImport } from "@/app/library/_services/importPipeline.js";
import { fileRefId } from "../recordFactory.js";

// IRON regression suite for the reuse branch of the import pipeline.
//
// PR-1 changes exactly one behavior here: importing new episodes onto an
// EXISTING series must bump series.updatedAt (via seriesRepo.touchSeries) so
// useLibrary's liveQuery re-emits and NewAdditionsRow surfaces the new
// download. Everything else in these tests locks the PRE-EXISTING behavior
// (episode creation, alternate-file attach, no dandan call on cache hit).

const NOW = Date.now();

function item(overrides = {}) {
  return {
    fileId: "f|700|0",
    file: { size: 700, lastModified: 0 },
    fileName: "[Sub] Frieren - 07.mkv",
    relativePath: "Frieren/[Sub] Frieren - 07.mkv",
    episode: 7,
    parsedKind: "main",
    parsedTitle: "Frieren",
    hash16M: "deadbeef",
    subtitle: null,
    ...overrides,
  };
}

function fakeDb({ seasons = [], episodes = [], cacheEntries = {} } = {}) {
  const writes = {
    episodes: [],
    fileRefs: [],
    seriesPuts: [],
    seriesUpdates: [],
    cachePuts: [],
  };
  const db = {
    seasons: { toArray: async () => seasons },
    userOverride: { toArray: async () => [] },
    episodes: {
      where: () => ({ equals: () => ({ toArray: async () => episodes }) }),
      bulkPut: async (rows) => {
        writes.episodes.push(...rows);
      },
    },
    fileRefs: {
      bulkPut: async (rows) => {
        writes.fileRefs.push(...rows);
      },
    },
    series: {
      put: async (row) => {
        writes.seriesPuts.push(row);
      },
      update: async (id, patch) => {
        writes.seriesUpdates.push({ id, patch });
      },
    },
    matchCache: {
      get: async (hash) => cacheEntries[hash],
      put: async (row) => {
        writes.cachePuts.push(row);
      },
      count: async () => 1,
    },
    transaction: async (_mode, _tables, fn) => fn(),
  };
  return { db, writes };
}

function fakeDandan() {
  const calls = [];
  return {
    calls,
    match: async (...args) => {
      calls.push(args);
      return null;
    },
  };
}

const REUSE_SETUP = {
  seasons: [{ id: "season-1", seriesId: "sr-1", animeId: 42, number: null }],
  cacheEntries: {
    deadbeef: {
      hash16M: "deadbeef",
      verdict: { kind: "new", animeId: 42 },
      updatedAt: NOW,
    },
  },
};

describe("importPipeline reuse branch", () => {
  test("new episode on an existing series: episode + fileRef written, NO new series, NO dandan call (regression)", async () => {
    const { db, writes } = fakeDb({
      ...REUSE_SETUP,
      episodes: [
        { id: "ep-1", seriesId: "sr-1", number: 1, primaryFileId: "old", alternateFileIds: [] },
      ],
    });
    const dandan = fakeDandan();

    const summary = await runImport(
      { items: [item()], libraryId: "lib-1" },
      { db, dandan },
    );

    expect(summary.matched).toBe(1);
    expect(summary.failed).toBe(0);
    expect(dandan.calls).toHaveLength(0);
    expect(writes.seriesPuts).toHaveLength(0);

    expect(writes.episodes).toHaveLength(1);
    expect(writes.episodes[0].seriesId).toBe("sr-1");
    expect(writes.episodes[0].seasonId).toBe("season-1");
    expect(writes.episodes[0].number).toBe(7);

    expect(writes.fileRefs).toHaveLength(1);
    expect(writes.fileRefs[0].relPath).toBe("Frieren/[Sub] Frieren - 07.mkv");
    expect(writes.fileRefs[0].matchStatus).toBe("matched");
    expect(writes.fileRefs[0].libraryId).toBe("lib-1");
  });

  test("bumps series.updatedAt so liveQuery/NewAdditionsRow surface the new download (PR-1 fix)", async () => {
    const { db, writes } = fakeDb({ ...REUSE_SETUP, episodes: [] });
    const before = Date.now();

    await runImport({ items: [item()], libraryId: "lib-1" }, { db, dandan: fakeDandan() });

    expect(writes.seriesUpdates).toHaveLength(1);
    expect(writes.seriesUpdates[0].id).toBe("sr-1");
    expect(writes.seriesUpdates[0].patch.updatedAt).toBeGreaterThanOrEqual(before);
  });

  test("same episode number, different file: attaches as alternateFileIds (regression) and still bumps updatedAt", async () => {
    const theItem = item();
    const expectedRefId = fileRefId(theItem);
    const { db, writes } = fakeDb({
      ...REUSE_SETUP,
      episodes: [
        { id: "ep-7", seriesId: "sr-1", number: 7, primaryFileId: "other-file", alternateFileIds: [] },
      ],
    });

    await runImport({ items: [theItem], libraryId: "lib-1" }, { db, dandan: fakeDandan() });

    expect(writes.episodes).toHaveLength(1);
    expect(writes.episodes[0].id).toBe("ep-7");
    expect(writes.episodes[0].alternateFileIds).toEqual([expectedRefId]);
    expect(writes.seriesUpdates).toHaveLength(1);
  });

  test("verdict is re-cached on the reuse path (regression)", async () => {
    const { db, writes } = fakeDb({ ...REUSE_SETUP, episodes: [] });
    await runImport({ items: [item()], libraryId: "lib-1" }, { db, dandan: fakeDandan() });
    expect(writes.cachePuts).toHaveLength(1);
    expect(writes.cachePuts[0].verdict).toEqual({ kind: "new", animeId: 42 });
  });
});

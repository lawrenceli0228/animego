import { describe, expect, test } from "bun:test";
import { runImport } from "@/app/library/_services/importPipeline.js";
import { fileRefId } from "../recordFactory.js";

// PR-2 pipeline hardening:
//   1. A cached bare {kind:'new'} verdict (no animeId) used to crash
//      upsertCluster (series:undefined) — every re-import of a local-title
//      series counted its clusters as failed. It must now re-match.
//   2. Re-import guard: a cluster whose every file is already homed on ONE
//      series flips to reuse instead of minting a duplicate series card
//      (covers moved/renamed files and "cache expired + dandan down").

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

function fakeDb({
  seasons = [],
  episodes = [],
  episodesById = {},
  fileRefsById = {},
  cacheEntries = {},
} = {}) {
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
      get: async (id) => episodesById[id],
      bulkPut: async (rows) => {
        writes.episodes.push(...rows);
      },
    },
    fileRefs: {
      get: async (id) => fileRefsById[id],
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

function nullDandan() {
  const calls = [];
  return {
    calls,
    match: async (...args) => {
      calls.push(args);
      return null;
    },
  };
}

describe("bare cached verdict fix", () => {
  test("cached {kind:'new'} without animeId re-matches instead of crashing the cluster", async () => {
    const { db, writes } = fakeDb({
      cacheEntries: {
        deadbeef: { hash16M: "deadbeef", verdict: { kind: "new" }, updatedAt: NOW },
      },
    });
    const dandan = nullDandan();

    const summary = await runImport(
      { items: [item()], libraryId: "lib-1" },
      { db, dandan },
    );

    // Pre-fix: failed=1 (upsertCluster threw on series:undefined).
    expect(summary.failed).toBe(0);
    expect(summary.matched).toBe(1);
    // Re-match happened: local matcher ran and dandan was consulted again.
    expect(dandan.calls).toHaveLength(1);
    // Local-title series persisted.
    expect(writes.seriesPuts).toHaveLength(1);
  });
});

describe("re-import guard (all files already homed)", () => {
  const theItem = item();
  const refId = fileRefId(theItem);
  const HOMED = {
    fileRefsById: {
      [refId]: { id: refId, episodeId: "ep-7", relPath: theItem.relativePath, size: 700 },
    },
    episodesById: {
      "ep-7": {
        id: "ep-7",
        seriesId: "sr-1",
        seasonId: "season-1",
        number: 7,
        primaryFileId: refId,
        alternateFileIds: [],
      },
    },
    episodes: [
      {
        id: "ep-7",
        seriesId: "sr-1",
        seasonId: "season-1",
        number: 7,
        primaryFileId: refId,
        alternateFileIds: [],
      },
    ],
  };

  test("flips to reuse: no duplicate series, updatedAt bumped, nothing cached", async () => {
    const { db, writes } = fakeDb(HOMED);

    const summary = await runImport(
      { items: [theItem], libraryId: "lib-1" },
      { db, dandan: nullDandan() },
    );

    expect(summary.matched).toBe(1);
    expect(summary.failed).toBe(0);
    // The whole point: NO fresh series minted for an already-imported cluster.
    expect(writes.seriesPuts).toHaveLength(0);
    // Reuse persistence ran: touchSeries bump + fileRef re-write.
    expect(writes.seriesUpdates).toHaveLength(1);
    expect(writes.seriesUpdates[0].id).toBe("sr-1");
    expect(writes.fileRefs.length).toBeGreaterThanOrEqual(1);
    // Derived home has no animeId — caching it would recreate the bare-entry
    // problem, so nothing is cached.
    expect(writes.cachePuts).toHaveLength(0);
  });

  test("ambiguous-homed file (episodeId null) skips the guard — proceeds as new", async () => {
    const { db, writes } = fakeDb({
      fileRefsById: {
        [refId]: { id: refId, episodeId: null, relPath: theItem.relativePath, size: 700 },
      },
    });

    await runImport({ items: [theItem], libraryId: "lib-1" }, { db, dandan: nullDandan() });

    expect(writes.seriesPuts).toHaveLength(1);
  });

  test("unknown file in the cluster skips the guard — proceeds as new", async () => {
    const { db, writes } = fakeDb();
    await runImport({ items: [theItem], libraryId: "lib-1" }, { db, dandan: nullDandan() });
    expect(writes.seriesPuts).toHaveLength(1);
  });

  test("cluster spanning two series skips the guard — never guesses across series", async () => {
    const a = item();
    const b = item({
      fileId: "g|800|0",
      file: { size: 800, lastModified: 0 },
      fileName: "[Sub] Frieren - 08.mkv",
      relativePath: "Frieren/[Sub] Frieren - 08.mkv",
      episode: 8,
      hash16M: "cafebabe",
    });
    const refA = fileRefId(a);
    const refB = fileRefId(b);
    const { db, writes } = fakeDb({
      fileRefsById: {
        [refA]: { id: refA, episodeId: "ep-a" },
        [refB]: { id: refB, episodeId: "ep-b" },
      },
      episodesById: {
        "ep-a": { id: "ep-a", seriesId: "sr-1", seasonId: "s1", number: 7, primaryFileId: refA },
        "ep-b": { id: "ep-b", seriesId: "sr-OTHER", seasonId: "s9", number: 8, primaryFileId: refB },
      },
    });

    await runImport({ items: [a, b], libraryId: "lib-1" }, { db, dandan: nullDandan() });

    expect(writes.seriesPuts).toHaveLength(1);
  });
});

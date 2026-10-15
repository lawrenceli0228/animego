import { describe, expect, test } from "bun:test";
import { runImport } from "@/app/[lang]/library/_services/importPipeline.js";

// Cross-batch home guards (watch-folder duplicate-card fix):
// a NEW file (unknown hash, dandan can't identify it) must join an existing
// series when a structural signal is unambiguous —
//   folder: its directory's existing files all belong to one series
//   title:  its normalized title uniquely matches one existing series
// and must NOT merge on mixed folders, title collisions, season conflicts,
// or when dandan positively identified the content as something else.

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
    hash16M: "newhash7",
    subtitle: null,
    ...overrides,
  };
}

function fakeDb({
  seasons = [],
  episodes = [],
  fileRefs = [],
  series = [],
  cacheEntries = {},
} = {}) {
  const writes = {
    episodes: [],
    fileRefs: [],
    seriesPuts: [],
    seriesUpdates: [],
  };
  const byId = (rows) => Object.fromEntries(rows.map((r) => [r.id, r]));
  const episodesById = byId(episodes);
  const fileRefsById = byId(fileRefs);
  const db = {
    seasons: { toArray: async () => seasons },
    userOverride: { toArray: async () => [] },
    series: {
      toArray: async () => series,
      get: async (id) => series.find((s) => s.id === id),
      put: async (row) => {
        writes.seriesPuts.push(row);
      },
      update: async (id, patch) => {
        writes.seriesUpdates.push({ id, patch });
      },
    },
    episodes: {
      toArray: async () => episodes,
      get: async (id) => episodesById[id],
      where: () => ({ equals: () => ({ toArray: async () => episodes } ) }),
      bulkPut: async (rows) => {
        writes.episodes.push(...rows);
      },
    },
    fileRefs: {
      toArray: async () => fileRefs,
      get: async (id) => fileRefsById[id],
      bulkPut: async (rows) => {
        writes.fileRefs.push(...rows);
      },
    },
    matchCache: {
      get: async (h) => cacheEntries[h],
      put: async () => {},
      count: async () => 1,
    },
    transaction: async (_m, _t, fn) => fn(),
  };
  return { db, writes };
}

function dandanReturning(result) {
  return { match: async () => result };
}

// Existing local-title series living in the Frieren/ folder.
const EXISTING = {
  series: [{ id: "sr-1", titleZh: "Frieren", titleEn: "Frieren", updatedAt: 0 }],
  episodes: [
    { id: "ep-1", seriesId: "sr-1", number: 1, primaryFileId: "ref-1", alternateFileIds: [] },
  ],
  fileRefs: [
    { id: "ref-1", episodeId: "ep-1", relPath: "Frieren/[Sub] Frieren - 01.mkv", size: 700 },
  ],
};

describe("folder home", () => {
  test("new episode in a folder owned by one series joins it — no duplicate card", async () => {
    const { db, writes } = fakeDb(EXISTING);
    const summary = await runImport(
      // Distinct parse title so ONLY the folder signal can explain a merge.
      { items: [item({ parsedTitle: "Sousou no Frieren S01" })], libraryId: "lib-1" },
      { db, dandan: dandanReturning(null) },
    );
    expect(summary.matched).toBe(1);
    expect(writes.seriesPuts).toHaveLength(0);
    expect(writes.seriesUpdates).toHaveLength(1);
    expect(writes.seriesUpdates[0].id).toBe("sr-1");
    expect(writes.episodes[0].seriesId).toBe("sr-1");
    expect(writes.episodes[0].number).toBe(7);
  });

  test("mixed folder (two owners) bails to a new series", async () => {
    const { db, writes } = fakeDb({
      series: [
        { id: "sr-A", titleZh: "Aaa", updatedAt: 0 },
        { id: "sr-B", titleZh: "Bbb", updatedAt: 0 },
      ],
      episodes: [
        { id: "ep-a", seriesId: "sr-A", number: 1, primaryFileId: "ra" },
        { id: "ep-b", seriesId: "sr-B", number: 1, primaryFileId: "rb" },
      ],
      fileRefs: [
        { id: "ra", episodeId: "ep-a", relPath: "Frieren/a.mkv", size: 1 },
        { id: "rb", episodeId: "ep-b", relPath: "Frieren/b.mkv", size: 2 },
      ],
    });
    await runImport(
      { items: [item({ parsedTitle: "Zzz Unique" })], libraryId: "lib-1" },
      { db, dandan: dandanReturning(null) },
    );
    expect(writes.seriesPuts).toHaveLength(1);
  });
});

describe("title home", () => {
  test("flat folder: unique normalized-title match joins the existing series", async () => {
    const { db, writes } = fakeDb({
      series: [{ id: "sr-1", titleZh: "Frieren", updatedAt: 0 }],
      // No fileRefs anywhere near Downloads/ — folder signal is silent.
    });
    await runImport(
      { items: [item({ relativePath: "Downloads/[Sub] Frieren - 07.mkv" })], libraryId: "lib-1" },
      { db, dandan: dandanReturning(null) },
    );
    expect(writes.seriesPuts).toHaveLength(0);
    expect(writes.seriesUpdates[0].id).toBe("sr-1");
  });

  test("title collision between two series is tombstoned — new series", async () => {
    const { db, writes } = fakeDb({
      series: [
        { id: "sr-1", titleZh: "Frieren", updatedAt: 0 },
        { id: "sr-2", titleEn: "Frieren", updatedAt: 0 },
      ],
    });
    await runImport(
      { items: [item({ relativePath: "Downloads/x.mkv" })], libraryId: "lib-1" },
      { db, dandan: dandanReturning(null) },
    );
    expect(writes.seriesPuts).toHaveLength(1);
  });

  test("season conflict blocks the merge (S2 files must not join an S1-only card)", async () => {
    const { db, writes } = fakeDb({
      series: [{ id: "sr-1", titleZh: "Frieren", updatedAt: 0 }],
      seasons: [{ id: "season-1", seriesId: "sr-1", animeId: 42, number: 1 }],
    });
    await runImport(
      {
        items: [item({ relativePath: "Downloads/x.mkv", parsedSeason: 2 })],
        libraryId: "lib-1",
      },
      { db, dandan: dandanReturning(null) },
    );
    expect(writes.seriesPuts).toHaveLength(1);
  });
});

describe("precedence", () => {
  test("a positive dandan identity outranks the folder signal", async () => {
    const { db, writes } = fakeDb(EXISTING);
    await runImport(
      { items: [item({ parsedTitle: "Some Other Show" })], libraryId: "lib-1" },
      // dandan says this is anime 999 — no existing season carries it, so a
      // NEW series with that identity must be minted despite the folder.
      { db, dandan: dandanReturning({ isMatched: true, animes: [{ animeId: 999 }] }) },
    );
    expect(writes.seriesPuts).toHaveLength(1);
    expect(writes.seriesUpdates).toHaveLength(0);
  });
});

// What the real client returns for a match: `/api/dandanplay/match` emits no
// dandanplay animeId, so `animes[0].animeId` is 0 on every matched import and
// the AniList id is the only identity the pipeline learns. The precedence test
// above models an `animeId` the client never produces, which is how a title
// guard overriding a positive identity went unnoticed.
function matchedAs(anilistId, title) {
  return {
    isMatched: true,
    animes: [{ animeId: 0, animeTitle: title }],
    enrichment: { titleZh: title },
    anilistId,
  };
}

// The reported case: "Koori no Jouheki - 16" against a library holding the
// first season (titled "Koori no Jouheki") and a second-season card made from
// a Netflix-named file, so only the first season's title matches the filename.
const KOORI = {
  series: [
    { id: "sr-s1", titleEn: "Koori no Jouheki", anilistId: 186497, updatedAt: 0 },
    { id: "sr-s2", titleEn: "Koori no Jouheki 2nd Season", anilistId: 213805, updatedAt: 0 },
  ],
};

function kooriItem(overrides = {}) {
  return item({
    fileName: "[SweetSub&LoliHouse] Koori no Jouheki - 16 [WebRip 1080p].mkv",
    relativePath: "[SweetSub&LoliHouse] Koori no Jouheki - 16 [WebRip 1080p].mkv",
    parsedTitle: "Koori no Jouheki",
    episode: 16,
    hash16M: "koori16",
    ...overrides,
  });
}

describe("AniList identity", () => {
  test("★ a match joins the card bound to its AniList id, not the card its title matches", async () => {
    const { db, writes } = fakeDb(KOORI);
    await runImport(
      { items: [kooriItem()], libraryId: "lib-1" },
      { db, dandan: dandanReturning(matchedAs(213805, "冰之城墙 第二季")) },
    );
    expect(writes.seriesPuts).toHaveLength(0);
    expect(writes.episodes).toHaveLength(1);
    expect(writes.episodes[0].seriesId).toBe("sr-s2");
  });

  test("★ a title home bound to a different AniList id is refused", async () => {
    // Only the first season is in the library. The match names a show no card
    // is bound to, so it mints its own card instead of filing under season 1.
    const { db, writes } = fakeDb({ series: [KOORI.series[0]] });
    await runImport(
      { items: [kooriItem()], libraryId: "lib-1" },
      { db, dandan: dandanReturning(matchedAs(213805, "冰之城墙 第二季")) },
    );
    expect(writes.seriesPuts).toHaveLength(1);
    expect(writes.episodes[0].seriesId).not.toBe("sr-s1");
  });

  test("a folder home bound to a different AniList id is refused", async () => {
    const { db, writes } = fakeDb({
      ...EXISTING,
      series: [{ ...EXISTING.series[0], anilistId: 154587 }],
    });
    await runImport(
      { items: [item({ parsedTitle: "Some Other Show" })], libraryId: "lib-1" },
      { db, dandan: dandanReturning(matchedAs(999999, "Some Other Show")) },
    );
    expect(writes.seriesPuts).toHaveLength(1);
  });

  test("a title home with no binding of its own still takes a matched file", async () => {
    // An unbound card is not evidence against the match; it is the card the
    // title guard exists to find.
    const { db, writes } = fakeDb({ series: [{ id: "sr-1", titleZh: "Frieren", updatedAt: 0 }] });
    await runImport(
      { items: [item({ relativePath: "Downloads/[Sub] Frieren - 07.mkv" })], libraryId: "lib-1" },
      { db, dandan: dandanReturning(matchedAs(154587, "Frieren")) },
    );
    expect(writes.seriesPuts).toHaveLength(0);
    expect(writes.episodes[0].seriesId).toBe("sr-1");
  });

  test("the same title home with the same AniList id joins it", async () => {
    const { db, writes } = fakeDb({ series: [{ ...KOORI.series[0] }] });
    await runImport(
      { items: [kooriItem({ episode: 14, hash16M: "koori14" })], libraryId: "lib-1" },
      { db, dandan: dandanReturning(matchedAs(186497, "冰之城墙")) },
    );
    expect(writes.seriesPuts).toHaveLength(0);
    expect(writes.episodes[0].seriesId).toBe("sr-s1");
  });
});
// (content-hash home precedence is locked by importPipeline.hardening.test.js)

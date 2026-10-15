import { describe, expect, test } from "bun:test";
import { runImport } from "@/app/[lang]/library/_services/importPipeline.js";
import { fileRefId } from "@/lib/library/recordFactory.js";
import { memoryDb } from "./memoryDb.js";

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
// ─── the match speaks for one file ──────────────────────────────────────────
//
// dandanplay is asked about the cluster's representative and nothing else. The
// clusterizer merges folders whose titles normalize alike, and "+ add folder"
// hands over every file, known or not, so a cluster can hold a season-one
// folder the library already filed plus a sequel's "- 16" at the root — and the
// root sorts first, so "- 16" is the one asked. Routing the whole cluster by
// that answer re-pointed all fourteen filed season-one files at the second
// season's card. These run the real clusterizer and persistence against an
// in-memory database and assert where every file ends up.

const S1_FOLDER = "[Sakurato] Koori no Jouheki [01 -14][AVC-8bit 1080P AAC][CHS]";

function s1Item(n, overrides = {}) {
  const name = `[Sakurato] Koori no Jouheki [${String(n).padStart(2, "0")}][AVC-8bit 1080P AAC][CHS].mp4`;
  return item({
    fileId: `${name}|1000|0`,
    file: { size: 1000, lastModified: 0 },
    fileName: name,
    relativePath: `${S1_FOLDER}/${name}`,
    parsedTitle: "Koori no Jouheki",
    episode: n,
    hash16M: `s1e${n}`,
    ...overrides,
  });
}

/** A row for a file the library already filed, keyed the way the pipeline keys it. */
function filedRef(it, episodeId) {
  return {
    id: fileRefId(it),
    libraryId: "lib-1",
    relPath: it.relativePath,
    size: it.file.size,
    mtime: 0,
    matchStatus: "matched",
    episodeId,
    hash16M: it.hash16M,
  };
}

function episodeRow(id, seriesId, number, primaryFileId) {
  return { id, seriesId, number, kind: "main", primaryFileId, alternateFileIds: [] };
}

/** dandanplay answering per file, the way prod answers these files. */
function dandanByHash(answers) {
  return { match: async (hash) => answers[hash] ?? null };
}

function seriesOfFile(db, it) {
  const ref = db.fileRefs.rows.get(fileRefId(it));
  return ref ? db.episodes.rows.get(ref.episodeId)?.seriesId : undefined;
}

const KOORI_S2_CARD = {
  series: { id: "sr-s2", titleEn: "Koori no Jouheki 2nd Season", anilistId: 213805, updatedAt: 0 },
  episode: episodeRow("s2-ep1", "sr-s2", 1, "s2e01-ref"),
  ref: {
    id: "s2e01-ref",
    libraryId: "lib-1",
    relPath: "The.Ramparts.of.Ice.S02E01.mkv",
    size: 5,
    mtime: 0,
    matchStatus: "matched",
    episodeId: "s2-ep1",
  },
};

describe("the match routes a cluster only when it speaks for every file", () => {
  test("★ files already filed stay put when a new file elsewhere in their cluster matches another card", async () => {
    // "+ add folder" after "- 16" arrived: the filed first season and the new
    // root file are one cluster, and "- 16" is its representative.
    const filed = [s1Item(1), s1Item(2)];
    const db = memoryDb({
      series: [{ ...KOORI.series[0], id: "sr-s1" }, KOORI_S2_CARD.series],
      episodes: [
        episodeRow("s1-ep1", "sr-s1", 1, fileRefId(filed[0])),
        episodeRow("s1-ep2", "sr-s1", 2, fileRefId(filed[1])),
        KOORI_S2_CARD.episode,
      ],
      fileRefs: [filedRef(filed[0], "s1-ep1"), filedRef(filed[1], "s1-ep2"), KOORI_S2_CARD.ref],
    });
    await runImport(
      { items: [...filed, kooriItem()], libraryId: "lib-1" },
      {
        db,
        dandan: dandanByHash({
          koori16: matchedAs(213805, "冰之城墙 第二季"),
          s1e1: matchedAs(186497, "冰之城墙"),
          s1e2: matchedAs(186497, "冰之城墙"),
        }),
      },
    );
    expect(seriesOfFile(db, filed[0])).toBe("sr-s1");
    expect(seriesOfFile(db, filed[1])).toBe("sr-s1");
    const s2Episodes = [...db.episodes.rows.values()].filter((e) => e.seriesId === "sr-s2");
    expect(s2Episodes.map((e) => e.id)).toEqual(["s2-ep1"]);
    expect(db.episodes.rows.get("s2-ep1").alternateFileIds).toEqual([]);
  });

  test("★ a file already filed stays put when a new file in its own folder is the one asked", async () => {
    // One folder: "05" is filed on card A, "01" is new and, being the lowest
    // number, is the representative. Its match names card B.
    const filed = item({
      fileId: "f5|700|0",
      fileName: "[Sub] Frieren - 05.mkv",
      relativePath: "Frieren/[Sub] Frieren - 05.mkv",
      episode: 5,
      hash16M: "frieren05",
    });
    const fresh = item({
      fileId: "f1|700|0",
      fileName: "[Sub] Frieren - 01.mkv",
      relativePath: "Frieren/[Sub] Frieren - 01.mkv",
      episode: 1,
      hash16M: "frieren01",
    });
    const db = memoryDb({
      series: [
        { id: "sr-a", titleEn: "Frieren", anilistId: 100, updatedAt: 0 },
        { id: "sr-b", titleEn: "Something Else", anilistId: 200, updatedAt: 0 },
      ],
      episodes: [episodeRow("a-ep5", "sr-a", 5, fileRefId(filed))],
      fileRefs: [filedRef(filed, "a-ep5")],
    });
    await runImport(
      { items: [filed, fresh], libraryId: "lib-1" },
      { db, dandan: dandanByHash({ frieren01: matchedAs(200, "Something Else") }) },
    );
    expect(seriesOfFile(db, filed)).toBe("sr-a");
    expect(seriesOfFile(db, fresh)).toBe("sr-a");
  });

  test("★ a cluster merged across folders is not filed on the card its representative matched", async () => {
    // Deleting the misfiled first-season card and rescanning: every file is
    // new, the folders merge by title, and "- 16" is asked. The first season
    // must not be filed on the second season's card.
    const fresh = [s1Item(1), s1Item(2)];
    const db = memoryDb({
      series: [KOORI_S2_CARD.series],
      episodes: [KOORI_S2_CARD.episode],
      fileRefs: [KOORI_S2_CARD.ref],
    });
    await runImport(
      { items: [...fresh, kooriItem()], libraryId: "lib-1" },
      {
        db,
        dandan: dandanByHash({
          koori16: matchedAs(213805, "冰之城墙 第二季"),
          s1e1: matchedAs(186497, "冰之城墙"),
          s1e2: matchedAs(186497, "冰之城墙"),
        }),
      },
    );
    expect(seriesOfFile(db, fresh[0])).not.toBe("sr-s2");
    expect(seriesOfFile(db, fresh[1])).not.toBe("sr-s2");
    expect(db.episodes.rows.get("s2-ep1").alternateFileIds).toEqual([]);
  });

  test("a binding made by a cluster merged across folders steers no later cluster", async () => {
    // A first import of all three files. However the clusters are ordered, no
    // file may end up hidden as another episode's alternate.
    const netflix = item({
      fileId: "nf|900|0",
      file: { size: 900, lastModified: 0 },
      fileName: "The.Ramparts.of.Ice.S02E01.Clouds.and.Rain.1080p.NF.WEB-DL.mkv",
      relativePath: "The.Ramparts.of.Ice.S02E01.Clouds.and.Rain.1080p.NF.WEB-DL.mkv",
      parsedTitle: "The Ramparts of Ice",
      parsedSeason: 2,
      episode: 1,
      hash16M: "nf-s2e01",
    });
    const db = memoryDb({});
    await runImport(
      { items: [s1Item(1), kooriItem(), netflix], libraryId: "lib-1" },
      {
        db,
        dandan: dandanByHash({
          koori16: matchedAs(213805, "冰之城墙 第二季"),
          s1e1: matchedAs(186497, "冰之城墙"),
          "nf-s2e01": matchedAs(213805, "冰之城墙 第二季"),
        }),
      },
    );
    for (const ep of db.episodes.rows.values()) {
      expect(ep.alternateFileIds ?? []).toEqual([]);
    }
  });

  test("a special in a bound show's folder still joins the show", async () => {
    // Specials are often their own AniList entry. The folder says which show
    // they belong to, the push only ever sends main episodes, and a card split
    // off here has no tool that would move it back.
    const special = item({
      fileId: "sp|700|0",
      fileName: "[Sub] Frieren - SP01.mkv",
      relativePath: "Frieren/[Sub] Frieren - SP01.mkv",
      episode: 1,
      parsedKind: "sp",
      hash16M: "frierenSP1",
    });
    const db = memoryDb({
      series: [{ ...EXISTING.series[0], anilistId: 154587 }],
      episodes: [{ ...EXISTING.episodes[0], seriesId: "sr-1" }],
      fileRefs: [{ ...EXISTING.fileRefs[0], libraryId: "lib-1" }],
    });
    await runImport(
      { items: [special], libraryId: "lib-1" },
      { db, dandan: dandanByHash({ frierenSP1: matchedAs(999001, "Frieren Special") }) },
    );
    expect(seriesOfFile(db, special)).toBe("sr-1");
  });

  test("a card merged into another does not lend its binding to new files", async () => {
    // watch sync already treats a merged-in card's binding as possibly stale;
    // filing by it would hide the real show's episode on someone else's card.
    const gamma = item({
      fileId: "g1|700|0",
      fileName: "[Sub] Gamma - 01.mkv",
      relativePath: "[Sub] Gamma - 01.mkv",
      parsedTitle: "Gamma",
      episode: 1,
      hash16M: "gamma01",
    });
    const db = memoryDb({
      series: [
        { id: "sr-root", titleEn: "Alpha", anilistId: 100, updatedAt: 0 },
        { id: "sr-merged", titleEn: "Beta", anilistId: 2002, updatedAt: 0 },
      ],
      userOverride: [{ seriesId: "sr-root", mergedFrom: ["sr-merged"], updatedAt: 0 }],
    });
    await runImport(
      { items: [gamma], libraryId: "lib-1" },
      { db, dandan: dandanByHash({ gamma01: matchedAs(2002, "Gamma") }) },
    );
    expect(seriesOfFile(db, gamma)).not.toBe("sr-merged");
    expect(seriesOfFile(db, gamma)).not.toBe("sr-root");
  });
});
// (content-hash home precedence is locked by importPipeline.hardening.test.js)

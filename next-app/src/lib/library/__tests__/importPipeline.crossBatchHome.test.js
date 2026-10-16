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
    // The filed folder answers from its card's binding, so none of its files
    // is sent to dandanplay, and "- 16" is split off and filed by its own
    // match (see "a cluster splits where its folders name different shows").
    const dandan = recordingByHash({
      koori16: matchedAs(213805, "冰之城墙 第二季"),
      s1e1: matchedAs(186497, "冰之城墙"),
      s1e2: matchedAs(186497, "冰之城墙"),
    });
    await runImport({ items: [...filed, kooriItem()], libraryId: "lib-1" }, { db, dandan });
    expect(seriesOfFile(db, filed[0])).toBe("sr-s1");
    expect(seriesOfFile(db, filed[1])).toBe("sr-s1");
    expect(seriesOfFile(db, kooriItem())).toBe("sr-s2");
    expect(db.episodes.rows.get("s2-ep1").alternateFileIds).toEqual([]);
    expect(dandan.asked).toEqual(["koori16"]);
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

// ─── each folder answers for itself ─────────────────────────────────────────
//
// The clusterizer merges folders by title alone, so one cluster can hold a
// first season's folder and a sequel's "- 16" at the root. On a first import
// (or after clearing the library) nothing is filed yet, and the cluster used to
// become ONE card named and bound by whichever file was asked — "- 16", since
// the root sorts first — so the first season showed up inside the second.
// Before matching, the pipeline now asks one file per folder and splits the
// cluster where the answers name different shows.

/** dandanplay answering per file, recording which files were asked. */
function recordingByHash(answers) {
  const asked = [];
  return {
    asked,
    match: async (hash) => {
      asked.push(hash);
      return answers[hash] ?? null;
    },
  };
}

function bindingOf(db, seriesId) {
  return db.series.rows.get(seriesId)?.anilistId;
}

describe("a cluster splits where its folders name different shows", () => {
  test("★ first import: the first season and the sequel's '- 16' get a card each", async () => {
    const s1 = [s1Item(1), s1Item(2)];
    const db = memoryDb({});
    await runImport(
      { items: [...s1, kooriItem()], libraryId: "lib-1" },
      {
        db,
        dandan: dandanByHash({
          koori16: matchedAs(213805, "冰之城墙 第二季"),
          s1e1: matchedAs(186497, "冰之城墙"),
          s1e2: matchedAs(186497, "冰之城墙"),
        }),
      },
    );
    const s1Card = seriesOfFile(db, s1[0]);
    const s2Card = seriesOfFile(db, kooriItem());
    expect(seriesOfFile(db, s1[1])).toBe(s1Card);
    expect(s1Card).not.toBe(s2Card);
    expect(bindingOf(db, s1Card)).toBe(186497);
    expect(bindingOf(db, s2Card)).toBe(213805);
    expect(db.series.rows.get(s1Card).titleZh).toBe("冰之城墙");
  });

  test("folders naming the same show stay one card, each folder asked once", async () => {
    const show = (dir, n) =>
      item({
        fileId: `jjk${n}|700|0`,
        fileName: `[Sub] Jujutsu Kaisen S3 - ${String(n).padStart(2, "0")}.mkv`,
        relativePath: `${dir}/[Sub] Jujutsu Kaisen S3 - ${String(n).padStart(2, "0")}.mkv`,
        parsedTitle: "Jujutsu Kaisen",
        episode: n,
        hash16M: `jjk${n}`,
      });
    const files = [show("JJK", 3), show("JJK", 4), show("JJK/extra", 1)];
    const answers = Object.fromEntries(files.map((f) => [f.hash16M, matchedAs(300, "咒术回战")]));
    const dandan = recordingByHash(answers);
    const db = memoryDb({});
    await runImport({ items: files, libraryId: "lib-1" }, { db, dandan });
    const cards = new Set(files.map((f) => seriesOfFile(db, f)));
    expect(cards.size).toBe(1);
    expect([...dandan.asked].sort()).toEqual(["jjk1", "jjk3"]);
  });

  test("a folder the match cannot place stays with its cluster", async () => {
    // No positive disagreement, no split: an unindexed folder of the same show
    // must not become a second card that nothing can fold back.
    const s1 = [s1Item(1), s1Item(2)];
    const db = memoryDb({});
    await runImport(
      { items: [...s1, kooriItem()], libraryId: "lib-1" },
      { db, dandan: dandanByHash({ koori16: matchedAs(213805, "冰之城墙 第二季") }) },
    );
    expect(seriesOfFile(db, s1[0])).toBe(seriesOfFile(db, kooriItem()));
  });

  test("the anchor folder already filed answers from its binding; only the new folder is asked", async () => {
    // Here the filed folder sorts first, so its file is the representative.
    const filed = item({
      fileId: "a1|700|0",
      fileName: "[A] Koori no Jouheki - 01.mkv",
      relativePath: "A-season1/[A] Koori no Jouheki - 01.mkv",
      parsedTitle: "Koori no Jouheki",
      episode: 1,
      hash16M: "a1",
    });
    const fresh = item({
      fileId: "b16|700|0",
      fileName: "[B] Koori no Jouheki - 16.mkv",
      relativePath: "B-new/[B] Koori no Jouheki - 16.mkv",
      parsedTitle: "Koori no Jouheki",
      episode: 16,
      hash16M: "b16",
    });
    const db = memoryDb({
      series: [{ ...KOORI.series[0], id: "sr-s1" }, KOORI_S2_CARD.series],
      episodes: [episodeRow("s1-ep1", "sr-s1", 1, fileRefId(filed)), KOORI_S2_CARD.episode],
      fileRefs: [filedRef(filed, "s1-ep1"), KOORI_S2_CARD.ref],
    });
    const dandan = recordingByHash({ b16: matchedAs(213805, "冰之城墙 第二季") });
    await runImport({ items: [filed, fresh], libraryId: "lib-1" }, { db, dandan });
    expect(seriesOfFile(db, filed)).toBe("sr-s1");
    expect(seriesOfFile(db, fresh)).toBe("sr-s2");
    expect(dandan.asked).toEqual(["b16"]);
  });

  test("three folders naming three shows become three cards", async () => {
    const at = (dir, hash, n) =>
      item({
        fileId: `${hash}|700|0`,
        fileName: `[Sub] Show - ${String(n).padStart(2, "0")}.mkv`,
        relativePath: `${dir}/[Sub] Show - ${String(n).padStart(2, "0")}.mkv`,
        parsedTitle: "Show",
        episode: n,
        hash16M: hash,
      });
    const files = [at("Show S1", "x1", 1), at("Show S2", "y13", 13), at("Show S3", "z25", 25)];
    const db = memoryDb({});
    await runImport(
      { items: files, libraryId: "lib-1" },
      {
        db,
        dandan: dandanByHash({
          x1: matchedAs(101, "Show"),
          y13: matchedAs(102, "Show 2"),
          z25: matchedAs(103, "Show 3"),
        }),
      },
    );
    const cards = files.map((f) => seriesOfFile(db, f));
    expect(new Set(cards).size).toBe(3);
    expect(cards.map((id) => bindingOf(db, id))).toEqual([101, 102, 103]);
  });

  test("no split when the representative's folder has no answer", async () => {
    // The other half of "only a positive disagreement splits".
    const s1 = [s1Item(1), s1Item(2)];
    const db = memoryDb({});
    const dandan = recordingByHash({ s1e1: matchedAs(186497, "冰之城墙") });
    await runImport({ items: [...s1, kooriItem()], libraryId: "lib-1" }, { db, dandan });
    expect(seriesOfFile(db, s1[0])).toBe(seriesOfFile(db, kooriItem()));
    expect(dandan.asked).toEqual(["koori16"]);
  });

  test("loose root files answer together, asked once through their representative", async () => {
    const root = (n, hash) =>
      kooriItem({
        fileId: `${hash}|700|0`,
        fileName: `[SweetSub] Koori no Jouheki - ${n}.mkv`,
        relativePath: `[SweetSub] Koori no Jouheki - ${n}.mkv`,
        episode: n,
        hash16M: hash,
      });
    const r15 = root(15, "r15");
    const r16 = root(16, "r16");
    const s1 = s1Item(1);
    const dandan = recordingByHash({
      r15: matchedAs(213805, "冰之城墙 第二季"),
      r16: matchedAs(213805, "冰之城墙 第二季"),
      s1e1: matchedAs(186497, "冰之城墙"),
    });
    const db = memoryDb({});
    await runImport({ items: [s1, r15, r16], libraryId: "lib-1" }, { db, dandan });
    expect(seriesOfFile(db, r15)).toBe(seriesOfFile(db, r16));
    expect(bindingOf(db, seriesOfFile(db, r15))).toBe(213805);
    expect(bindingOf(db, seriesOfFile(db, s1))).toBe(186497);
    expect([...dandan.asked].sort()).toEqual(["r15", "s1e1"]);
  });

  test("each part reports its own progress row", async () => {
    // ImportDrawer keys its rows by clusterKey.
    const events = [];
    await runImport(
      { items: [s1Item(1), kooriItem()], libraryId: "lib-1" },
      {
        db: memoryDb({}),
        dandan: dandanByHash({
          koori16: matchedAs(213805, "冰之城墙 第二季"),
          s1e1: matchedAs(186497, "冰之城墙"),
        }),
        onEvent: (e) => events.push(e),
      },
    );
    const starts = events.filter((e) => e.kind === "clusterStart").map((e) => e.clusterKey);
    expect(starts).toHaveLength(2);
    expect(new Set(starts).size).toBe(2);
    expect(events.at(-1).summary.clusters).toBe(2);
  });

  test("a client that throws fails the cluster without ending the batch", async () => {
    const asked = [];
    const dandan = {
      match: async (hash) => {
        asked.push(hash);
        throw new Error("network down");
      },
    };
    const db = memoryDb({});
    const summary = await runImport(
      { items: [s1Item(1), kooriItem()], libraryId: "lib-1" },
      { db, dandan },
    );
    expect(summary.failed).toBe(1);
    expect(asked).toEqual(["koori16"]);
  });

  test("★ an ask that failed is not retried within the batch", async () => {
    // Retrying would let the match name the whole cluster after the split
    // could not ask: the first season would be filed as the second again.
    const asked = [];
    const dandan = {
      match: async (hash) => {
        asked.push(hash);
        if (hash === "koori16" && asked.filter((h) => h === hash).length === 1) {
          throw new Error("blip");
        }
        if (hash === "koori16") return matchedAs(213805, "冰之城墙 第二季");
        return matchedAs(186497, "冰之城墙");
      },
    };
    const s1 = [s1Item(1), s1Item(2)];
    const db = memoryDb({});
    const summary = await runImport({ items: [...s1, kooriItem()], libraryId: "lib-1" }, { db, dandan });
    expect(asked).toEqual(["koori16"]);
    expect(summary.failed).toBe(1);
    expect(bindingOf(db, seriesOfFile(db, s1[0]))).not.toBe(213805);
  });

  test("a folder of specials is never split off its show", async () => {
    const main = item({
      fileId: "fm1|700|0",
      fileName: "[Sub] Frieren - 01.mkv",
      relativePath: "Frieren/[Sub] Frieren - 01.mkv",
      episode: 1,
      hash16M: "frieren01",
    });
    const special = item({
      fileId: "fsp1|700|0",
      fileName: "[Sub] Frieren - SP01.mkv",
      relativePath: "Frieren/SPs/[Sub] Frieren - SP01.mkv",
      episode: 1,
      parsedKind: "sp",
      hash16M: "frierenSP1",
    });
    const dandan = recordingByHash({
      frieren01: matchedAs(154587, "葬送的芙莉莲"),
      frierenSP1: matchedAs(999001, "Frieren Special"),
    });
    const db = memoryDb({});
    await runImport({ items: [main, special], libraryId: "lib-1" }, { db, dandan });
    expect(seriesOfFile(db, special)).toBe(seriesOfFile(db, main));
    expect(dandan.asked).not.toContain("frierenSP1");
  });
});

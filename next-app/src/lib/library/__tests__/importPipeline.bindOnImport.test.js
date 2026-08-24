import { describe, expect, test } from "bun:test";
import { runImport } from "@/app/[lang]/library/_services/importPipeline.js";

// The AniList id arrives on every matched import and used to be thrown away.
//
// `siteAnime.anilistId` is emitted by go-api in BOTH phases that produce a
// siteAnime (`match.go:213` phase 1, `:275` phase 2). `mergeAnimeFields` read
// it, `pickEnrichment` dropped it, and `importPipeline.js` contained zero
// occurrences of the string. So the exact id needed to bind a series for
// watch-progress sync was already in hand, and the series stayed unbound until
// a human clicked the card.
//
// This file pins three things:
//
//   1. THE WRITE. A fresh, dandan-identified import binds the series it just
//      created — through `animeBinding.writeBinding`, never around it.
//   2. THE INDEPENDENCE. Season row (dandanplay identity), enrichment (title +
//      poster) and binding (AniList identity) are three separate switches. The
//      season/enrichment split landed earlier on this branch precisely because
//      those two had been fused; the binding must not now get fused to either.
//   3. THE REACH. Honest limits, asserted rather than described: a reuse
//      verdict does not bind, and a matchCache hit does not bind. Those are not
//      oversights, they are the boundary of "a row this import created".

/** The only kind of series update that counts as a binding. */
const bindingUpdates = (writes) =>
  writes.seriesUpdates.filter((u) => u.patch && "anilistId" in u.patch);

function item(overrides = {}) {
  return {
    fileId: "f|900|0",
    file: { size: 900, lastModified: 0 },
    fileName: "[Nekomoe kissaten] Unknown Show - 01.mkv",
    relativePath: "Unknown/[Nekomoe kissaten] Unknown Show - 01.mkv",
    episode: 1,
    parsedKind: "main",
    parsedTitle: "Nekomoe kissaten",
    hash16M: "cafebabe",
    subtitle: null,
    ...overrides,
  };
}

/**
 * A db fake that actually stores series rows.
 *
 * `writeBinding` reads the row back before deciding (`db.series.get`), so a
 * fake whose `get` always returns undefined would report `missing-series` and
 * silently prove nothing. Storing on `put` is what makes these assertions real.
 */
function fakeDb({
  seasons = [],
  overrides = [],
  cacheEntry = null,
  lockEverything = false,
  failSeriesUpdate = false,
} = {}) {
  const seriesRows = new Map();
  const overrideRows = new Map(overrides.map((o) => [o.seriesId, o]));
  const writes = {
    episodes: [],
    fileRefs: [],
    seriesPuts: [],
    seriesUpdates: [],
    seasonPuts: [],
    overridePuts: [],
    cachePuts: [],
  };
  const db = {
    seasons: {
      toArray: async () => seasons.slice(),
      get: async () => undefined,
      put: async (row) => {
        writes.seasonPuts.push(row);
      },
      bulkPut: async (rows) => {
        writes.seasonPuts.push(...rows);
      },
    },
    userOverride: {
      toArray: async () => [...overrideRows.values()],
      get: async (id) => (lockEverything ? { locked: true } : overrideRows.get(id)),
      put: async (row) => {
        writes.overridePuts.push(row);
        overrideRows.set(row.seriesId, row);
      },
    },
    episodes: {
      toArray: async () => [],
      get: async () => undefined,
      where: () => ({ equals: () => ({ toArray: async () => [] }) }),
      bulkPut: async (rows) => {
        writes.episodes.push(...rows);
      },
    },
    fileRefs: {
      toArray: async () => [],
      get: async () => undefined,
      bulkPut: async (rows) => {
        writes.fileRefs.push(...rows);
      },
    },
    series: {
      toArray: async () => [...seriesRows.values()],
      get: async (id) => seriesRows.get(id),
      put: async (row) => {
        writes.seriesPuts.push(row);
        seriesRows.set(row.id, { ...row });
      },
      update: async (id, patch) => {
        if (failSeriesUpdate) throw new Error("IDB write failed");
        writes.seriesUpdates.push({ id, patch });
        const row = seriesRows.get(id);
        if (row) seriesRows.set(id, { ...row, ...patch });
      },
    },
    matchCache: {
      get: async () => cacheEntry,
      put: async (row) => {
        writes.cachePuts.push(row);
      },
      count: async () => 1,
    },
    transaction: async (_mode, _tables, fn) => fn(),
  };
  return { db, writes, seriesRows };
}

/** A dandan client that matched, with whatever three facts we hand it. */
function fakeDandan({ animeId, anilistId, enrichment } = {}) {
  const calls = [];
  return {
    calls,
    match: async (...args) => {
      calls.push(args);
      return {
        isMatched: true,
        animes: [{ animeId, animeTitle: "Whatever" }],
        anilistId,
        enrichment,
      };
    },
  };
}

const ENRICHMENT = {
  titleZh: "更衣人偶坠入爱河",
  titleEn: "Sono Bisque Doll wa Koi wo Suru",
  posterUrl: "https://example.invalid/poster.jpg",
};

describe("importPipeline — binding at import time", () => {
  test("★ an AniList id on the match binds the series this import created", async () => {
    // Arrange
    const { db, writes, seriesRows } = fakeDb();

    // Act
    const summary = await runImport(
      { items: [item()], libraryId: "lib-1" },
      { db, dandan: fakeDandan({ anilistId: 21, enrichment: ENRICHMENT }) },
    );

    // Assert
    expect(summary.failed).toBe(0);
    expect(writes.seriesPuts).toHaveLength(1);
    const seriesId = writes.seriesPuts[0].id;
    expect(bindingUpdates(writes)).toEqual([
      { id: seriesId, patch: { anilistId: 21 } },
    ]);
    expect(seriesRows.get(seriesId).anilistId).toBe(21);
  });

  test("the write lands AFTER the series row, because `put` replaces it", async () => {
    // Arrange — `seriesRepo.upsertCluster` does `db.series.put(series)`, which
    // erases any field the payload does not carry. A binding set on the record
    // beforehand would not survive; this asserts the ordering that makes it.
    const { db, writes } = fakeDb();

    // Act
    await runImport(
      { items: [item()], libraryId: "lib-1" },
      { db, dandan: fakeDandan({ anilistId: 21 }) },
    );

    // Assert — the payload the pipeline `put` carries no anilistId of its own.
    expect(writes.seriesPuts[0].anilistId).toBeUndefined();
    expect(bindingUpdates(writes)).toHaveLength(1);
  });

  test("no AniList id → no binding write, and a perfectly ordinary import", async () => {
    // Arrange
    const { db, writes } = fakeDb();

    // Act
    const summary = await runImport(
      { items: [item()], libraryId: "lib-1" },
      { db, dandan: fakeDandan({ enrichment: ENRICHMENT }) },
    );

    // Assert
    expect(summary.failed).toBe(0);
    expect(bindingUpdates(writes)).toHaveLength(0);
    expect(writes.seriesPuts).toHaveLength(1);
    expect(writes.episodes).toHaveLength(1);
    expect(writes.fileRefs).toHaveLength(1);
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["null", null],
    ["a non-numeric string", "abc"],
    ["absent", undefined],
  ])("%s is never written to Series.anilistId", async (_label, bad) => {
    // Arrange — `Series.anilistId` is indexed and reverse-queried; a 0 in it
    // would be a live-looking binding to nothing.
    const { db, writes, seriesRows } = fakeDb();

    // Act
    await runImport(
      { items: [item()], libraryId: "lib-1" },
      { db, dandan: fakeDandan({ anilistId: bad }) },
    );

    // Assert
    expect(bindingUpdates(writes)).toHaveLength(0);
    const seriesId = writes.seriesPuts[0].id;
    expect(seriesRows.get(seriesId).anilistId).toBeUndefined();
  });

  test("★ the import writes as `auto`, so a lock still wins", async () => {
    // Arrange — contrived on purpose. A freshly minted ulid cannot carry a
    // prior lock, so making the lock unconditional is the only way to prove
    // WHICH DOOR the write goes through. If this ever starts writing
    // `series.anilistId` directly, this is the test that notices.
    const { db, writes } = fakeDb({ lockEverything: true });

    // Act
    await runImport(
      { items: [item()], libraryId: "lib-1" },
      { db, dandan: fakeDandan({ anilistId: 21, enrichment: ENRICHMENT }) },
    );

    // Assert — refused, and the import is otherwise untouched.
    expect(bindingUpdates(writes)).toHaveLength(0);
    expect(writes.seriesPuts[0].titleZh).toBe(ENRICHMENT.titleZh);
    expect(writes.episodes).toHaveLength(1);
  });

  test("a failing binding write does not fail the import", async () => {
    // Arrange — `runImport` counts a throwing cluster as `failed`, so an
    // unavailable table here would cost the user their files. The binding is
    // recoverable (the mount-time sweep re-asks); the import is not.
    const { db, writes } = fakeDb({ failSeriesUpdate: true });

    // Act
    const summary = await runImport(
      { items: [item()], libraryId: "lib-1" },
      { db, dandan: fakeDandan({ anilistId: 21, enrichment: ENRICHMENT }) },
    );

    // Assert
    expect(summary.failed).toBe(0);
    expect(summary.matched).toBe(1);
    expect(writes.seriesPuts).toHaveLength(1);
    expect(writes.episodes).toHaveLength(1);
    expect(writes.fileRefs).toHaveLength(1);
  });
});

describe("importPipeline — season, enrichment and binding are three switches", () => {
  test("all three present: Season row, titles, and a binding", async () => {
    // Arrange
    const { db, writes } = fakeDb();

    // Act
    await runImport(
      { items: [item()], libraryId: "lib-1" },
      {
        db,
        dandan: fakeDandan({
          animeId: 17630,
          anilistId: 21,
          enrichment: ENRICHMENT,
        }),
      },
    );

    // Assert
    expect(writes.seasonPuts).toHaveLength(1);
    expect(writes.seasonPuts[0].animeId).toBe(17630);
    expect(writes.seriesPuts[0].titleZh).toBe(ENRICHMENT.titleZh);
    expect(bindingUpdates(writes)).toHaveLength(1);
  });

  test("no dandanplay id: no Season row, but titles AND the binding land", async () => {
    // Arrange — the ordinary case today, since `/match` emits no dandanplay
    // animeId in any phase.
    const { db, writes } = fakeDb();

    // Act
    await runImport(
      { items: [item()], libraryId: "lib-1" },
      { db, dandan: fakeDandan({ anilistId: 21, enrichment: ENRICHMENT }) },
    );

    // Assert
    expect(writes.seasonPuts).toHaveLength(0);
    expect(writes.seriesPuts[0].titleZh).toBe(ENRICHMENT.titleZh);
    expect(bindingUpdates(writes)).toHaveLength(1);
  });

  test("no enrichment: no titles, but the Season row AND the binding land", async () => {
    // Arrange
    const { db, writes } = fakeDb();

    // Act
    await runImport(
      { items: [item()], libraryId: "lib-1" },
      { db, dandan: fakeDandan({ animeId: 17630, anilistId: 21 }) },
    );

    // Assert — the card keeps the parser-derived title, which is the fansub
    // group here, and is still bound.
    expect(writes.seasonPuts).toHaveLength(1);
    expect(writes.seriesPuts[0].titleZh).toBe("Nekomoe kissaten");
    expect(bindingUpdates(writes)).toHaveLength(1);
  });

  test("★ an AniList id ALONE still binds — no Season, no titles", async () => {
    // Arrange — the third fact standing entirely on its own. Nothing else the
    // envelope carried was usable, and the series is still bound for sync.
    const { db, writes } = fakeDb();

    // Act
    await runImport(
      { items: [item()], libraryId: "lib-1" },
      { db, dandan: fakeDandan({ anilistId: 21 }) },
    );

    // Assert
    expect(writes.seasonPuts).toHaveLength(0);
    expect(writes.seriesPuts[0].titleZh).toBe("Nekomoe kissaten");
    expect(bindingUpdates(writes)).toHaveLength(1);
  });

  test("a Season row does not imply a binding", async () => {
    // Arrange — the converse, so the two cannot quietly become one flag again.
    const { db, writes } = fakeDb();

    // Act
    await runImport(
      { items: [item()], libraryId: "lib-1" },
      { db, dandan: fakeDandan({ animeId: 17630, enrichment: ENRICHMENT }) },
    );

    // Assert
    expect(writes.seasonPuts).toHaveLength(1);
    expect(bindingUpdates(writes)).toHaveLength(0);
  });
});

describe("importPipeline — the honest reach of import-time binding", () => {
  test("a REUSE verdict does not bind: that row is not ours to claim", async () => {
    // Arrange — a prior season already owns this animeId, so the cluster is
    // folded into an existing series. That series may already carry a binding
    // the reader chose, and this import created nothing.
    const { db, writes } = fakeDb({
      seasons: [
        { id: "season-1", seriesId: "series-1", animeId: 17630, number: 1 },
      ],
    });

    // Act
    await runImport(
      { items: [item()], libraryId: "lib-1" },
      { db, dandan: fakeDandan({ animeId: 17630, anilistId: 21 }) },
    );

    // Assert — reused (no new series row), touched, never bound.
    expect(writes.seriesPuts).toHaveLength(0);
    expect(writes.seriesUpdates.some((u) => "updatedAt" in u.patch)).toBe(true);
    expect(bindingUpdates(writes)).toHaveLength(0);
  });

  test("a matchCache hit does not bind: the cache has never stored the id", async () => {
    // Arrange — a cached verdict short-circuits the dandan call entirely, and
    // `buildCachePayload` stores only `{kind, animeId, enrichment}`. This is
    // the branch that keeps import-time binding a FIRST-import feature; a
    // re-import of the same files learns nothing new.
    const { db, writes } = fakeDb({
      cacheEntry: {
        hash16M: "cafebabe",
        updatedAt: Date.now(),
        verdict: { kind: "new", animeId: 17630, enrichment: ENRICHMENT },
      },
    });
    const dandan = fakeDandan({ anilistId: 21 });

    // Act
    await runImport({ items: [item()], libraryId: "lib-1" }, { db, dandan });

    // Assert — a series was created from the cached verdict, unbound, and
    // dandanplay was never asked.
    expect(dandan.calls).toHaveLength(0);
    expect(writes.seriesPuts).toHaveLength(1);
    expect(bindingUpdates(writes)).toHaveLength(0);
  });
});

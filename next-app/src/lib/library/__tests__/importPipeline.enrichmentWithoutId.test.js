import { describe, expect, test } from "bun:test";
import { runImport } from "@/app/[lang]/library/_services/importPipeline.js";

// Identity and metadata used to ride the same truthiness check.
//
// `applyEnrichment` writes two things: a Season row (which IS the dandanplay
// identity) and the title/poster folded onto the Series row (which is not).
// Both used to live inside the caller's `else if (dandanResult.animeId)`
// branch, so they stood or fell together.
//
// That was invisible while `dandanClient` substituted a bgm.tv subject id when
// no dandanplay id was available — the value was wrong but truthy, so the
// branch ran and the titles landed. Removing that substitution (correctly: the
// two id spaces collide and both resolve, so a wrong id is undetectable
// downstream) made the id falsy, and the titles silently went with it. A fresh
// card would then be named after whatever the filename parser scraped out of
// the folder, frequently the fansub group.
//
// These tests pin the two facts apart:
//   · no usable id  → NO Season row, because there is no identity to record
//                     (and a row stored at 0 is worse than none: dedupeSeries
//                     keys on `typeof animeId !== 'number'`, so a 0 passes as
//                     real and folds every id-less series onto one card)
//   · enrichment    → applied either way, because it never depended on the id

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

function fakeDb() {
  const writes = {
    episodes: [],
    fileRefs: [],
    seriesPuts: [],
    seriesUpdates: [],
    seasonPuts: [],
    cachePuts: [],
  };
  const db = {
    seasons: {
      toArray: async () => [],
      get: async () => undefined,
      put: async (row) => {
        writes.seasonPuts.push(row);
      },
      bulkPut: async (rows) => {
        writes.seasonPuts.push(...rows);
      },
    },
    userOverride: { toArray: async () => [] },
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
      toArray: async () => [],
      get: async () => undefined,
      put: async (row) => {
        writes.seriesPuts.push(row);
      },
      update: async (id, patch) => {
        writes.seriesUpdates.push({ id, patch });
      },
    },
    matchCache: {
      get: async () => undefined,
      put: async (row) => {
        writes.cachePuts.push(row);
      },
      count: async () => 1,
    },
    transaction: async (_mode, _tables, fn) => fn(),
  };
  return { db, writes };
}

/** A dandanplay client that matched, with whatever id/enrichment we hand it. */
function fakeDandan({ animeId, enrichment } = {}) {
  return {
    match: async () => ({
      isMatched: true,
      animes: [{ animeId, animeTitle: "Whatever" }],
      enrichment,
    }),
  };
}

const ENRICHMENT = {
  titleZh: "更衣人偶坠入爱河",
  titleEn: "Sono Bisque Doll wa Koi wo Suru",
  posterUrl: "https://example.invalid/poster.jpg",
};

describe("importPipeline — enrichment does not depend on having an id", () => {
  test("★ matched with NO animeId: titles land, no Season row is written", async () => {
    const { db, writes } = fakeDb();

    const summary = await runImport(
      { items: [item()], libraryId: "lib-1" },
      { db, dandan: fakeDandan({ animeId: undefined, enrichment: ENRICHMENT }) },
    );

    expect(summary.failed).toBe(0);
    expect(writes.seriesPuts).toHaveLength(1);
    expect(writes.seriesPuts[0].titleZh).toBe(ENRICHMENT.titleZh);
    expect(writes.seriesPuts[0].posterUrl).toBe(ENRICHMENT.posterUrl);
    // The whole point: no identity, so no Season row rather than one at 0.
    expect(writes.seasonPuts).toHaveLength(0);
  });

  test("matched WITH an animeId: titles land and a Season row is written", async () => {
    const { db, writes } = fakeDb();

    await runImport(
      { items: [item()], libraryId: "lib-1" },
      { db, dandan: fakeDandan({ animeId: 17630, enrichment: ENRICHMENT }) },
    );

    expect(writes.seriesPuts[0].titleZh).toBe(ENRICHMENT.titleZh);
    expect(writes.seasonPuts).toHaveLength(1);
    expect(writes.seasonPuts[0].animeId).toBe(17630);
  });

  test("★ a zero animeId is treated as absent, not as an identity", async () => {
    // `dedupeSeries` keys on `typeof season.animeId !== 'number'`, so a stored
    // 0 would read as a real id and merge unrelated cards. Nothing writes one
    // today and this is the line that keeps it that way.
    const { db, writes } = fakeDb();

    await runImport(
      { items: [item()], libraryId: "lib-1" },
      { db, dandan: fakeDandan({ animeId: 0, enrichment: ENRICHMENT }) },
    );

    expect(writes.seasonPuts).toHaveLength(0);
    expect(writes.seriesPuts[0].titleZh).toBe(ENRICHMENT.titleZh);
  });

  test("no id and no enrichment is a clean import, not a crash", async () => {
    const { db, writes } = fakeDb();

    const summary = await runImport(
      { items: [item()], libraryId: "lib-1" },
      { db, dandan: fakeDandan({ animeId: undefined, enrichment: undefined }) },
    );

    expect(summary.failed).toBe(0);
    expect(writes.seriesPuts).toHaveLength(1);
    expect(writes.seasonPuts).toHaveLength(0);
    expect(writes.episodes).toHaveLength(1);
    expect(writes.fileRefs).toHaveLength(1);
  });

  test("an id-less import still writes its episode and file rows", async () => {
    // The card has to be usable even when nothing identified it — the reader
    // can rematch it by hand later, and that only works if the files landed.
    const { db, writes } = fakeDb();

    await runImport(
      { items: [item()], libraryId: "lib-1" },
      { db, dandan: fakeDandan({ animeId: undefined, enrichment: ENRICHMENT }) },
    );

    expect(writes.episodes).toHaveLength(1);
    expect(writes.episodes[0].number).toBe(1);
    // No season, so the episode carries no seasonId to dangle.
    expect(writes.episodes[0].seasonId).toBeUndefined();
    expect(writes.fileRefs).toHaveLength(1);
    expect(writes.fileRefs[0].matchStatus).toBe("matched");
  });
});

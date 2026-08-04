import { describe, expect, test } from "bun:test";
import { extractSeasonMarker, pickBestHit, scoreTitleMatch } from "./seasonMatch";

// Locks the wrong-season fix. The library card used to resolve its site
// metadata with `hits[0]` plus a substring score, which ties across every
// season of a franchise ("无职转生" is inside all of them) — so the first
// row of an unranked ILIKE won, and a 无职转生Ⅲ card rendered 无职转生Ⅱ's
// rating, year, episode count and "view details" link.
//
// Fixtures are the real rows prod returns for the keyword "无职转生",
// in the anilist_id order the query now guarantees.
const MUSHOKU = [
  {
    anilistId: 108465,
    titleChinese: "无职转生～到了异世界就拿出真本事～",
    titleNative: "無職転生 ～異世界行ったら本気だす～",
    titleRomaji: "Mushoku Tensei: Isekai Ittara Honki Dasu",
  },
  {
    anilistId: 127720,
    titleChinese: "无职转生～到了异世界就拿出真本事～ 第2部分",
    titleNative: "無職転生 ～異世界行ったら本気だす～ 第2クール",
    titleRomaji: "Mushoku Tensei: Isekai Ittara Honki Dasu Part 2",
  },
  {
    anilistId: 146065,
    titleChinese: "无职转生 第二季 ～到了异世界就拿出真本事～",
    titleNative: "無職転生Ⅱ ～異世界行ったら本気だす～",
    titleRomaji: "Mushoku Tensei II: Isekai Ittara Honki Dasu",
  },
  {
    anilistId: 166873,
    titleChinese: "无职转生 第二季 ～到了异世界就拿出真本事～ 第2部分",
    titleNative: "無職転生Ⅱ ～異世界行ったら本気だす～ 第2クール",
    titleRomaji: "Mushoku Tensei II: Isekai Ittara Honki Dasu Part 2",
  },
  {
    anilistId: 178789,
    titleChinese: "无职转生 第三季 ～到了异世界就拿出真本事～",
    titleNative: "無職転生Ⅲ ～異世界行ったら本気だす～",
    titleRomaji: "Mushoku Tensei III: Isekai Ittara Honki Dasu",
  },
];

describe("extractSeasonMarker", () => {
  test.each([
    ["无职转生 第二季 ～到了异世界就拿出真本事～", 2, 0],
    ["无职转生 第三季 ～到了异世界就拿出真本事～", 3, 0],
    ["無職転生Ⅱ ～異世界行ったら本気だす～", 2, 0],
    ["無職転生Ⅲ ～異世界行ったら本気だす～", 3, 0],
    ["Mushoku Tensei III: Isekai Ittara Honki Dasu", 3, 0],
    ["無職転生 ～異世界行ったら本気だす～", 0, 0],
    ["Overlord Season 3", 3, 0],
    ["Attack on Titan 2nd Season", 2, 0],
    ["アオアシ 第2期", 2, 0],
  ])("reads season out of %p", (title, season, part) => {
    expect(extractSeasonMarker(title)).toEqual({ season, part });
  });

  test("a cour split is a part, not a season", () => {
    // 第2クール advances the part, never the season number.
    expect(extractSeasonMarker("無職転生Ⅱ ～異世界行ったら本気だす～ 第2クール")).toEqual({
      season: 2,
      part: 2,
    });
    expect(extractSeasonMarker("无职转生～到了异世界就拿出真本事～ 第2部分")).toEqual({
      season: 0,
      part: 2,
    });
    expect(extractSeasonMarker("Mushoku Tensei: Isekai Ittara Honki Dasu Part 2")).toEqual({
      season: 0,
      part: 2,
    });
  });

  test("does not mistake stray letters for numerals", () => {
    // "x" and bare "v" are excluded on purpose.
    expect(extractSeasonMarker("Hunter x Hunter")).toEqual({ season: 0, part: 0 });
    expect(extractSeasonMarker("Gundam V")).toEqual({ season: 0, part: 0 });
    expect(extractSeasonMarker("")).toEqual({ season: 0, part: 0 });
  });
});

describe("pickBestHit", () => {
  test("resolves the requested season, not the first row", () => {
    // The live regression. 146065 (season 2) is what hits[0] used to give.
    expect(pickBestHit(MUSHOKU, "无职转生Ⅲ ～到了异世界就拿出真本事～")?.anilistId).toBe(178789);
  });

  test("separates every season and part of the franchise", () => {
    const cases: [string, number][] = [
      ["无职转生～到了异世界就拿出真本事～", 108465],
      ["无职转生～到了异世界就拿出真本事～ 第2部分", 127720],
      ["无职转生 第二季 ～到了异世界就拿出真本事～", 146065],
      ["无职转生 第二季 ～到了异世界就拿出真本事～ 第2部分", 166873],
      ["无职转生 第三季 ～到了异世界就拿出真本事～", 178789],
      ["Mushoku Tensei III: Isekai Ittara Honki Dasu", 178789],
    ];
    for (const [query, want] of cases) {
      expect(pickBestHit(MUSHOKU, query)?.anilistId).toBe(want);
    }
  });

  test("returns null rather than a wrong season", () => {
    // Season 4 is not in the cache. Null leaves the card un-enriched;
    // any non-null answer here would be a wrong rating and a wrong link.
    expect(pickBestHit(MUSHOKU, "无职转生Ⅳ ～到了异世界就拿出真本事～")).toBeNull();
  });

  test("a bare franchise keyword resolves to season 1, never a later season", () => {
    // A folder name carries no ordinal, which reads as season 1.
    expect(pickBestHit(MUSHOKU, "无职转生")?.anilistId).toBe(108465);
  });

  test("returns null for an unrelated query and for empty input", () => {
    expect(pickBestHit(MUSHOKU, "紫罗兰永恒花园")).toBeNull();
    expect(pickBestHit([], "无职转生")).toBeNull();
    expect(pickBestHit(MUSHOKU, "")).toBeNull();
  });

  test("still enriches an ordinary single-season show", () => {
    // The guard must not cost enrichment on the common case.
    const hits = [{ anilistId: 21827, titleChinese: "紫罗兰永恒花园" }];
    expect(pickBestHit(hits, "紫罗兰永恒花园")?.anilistId).toBe(21827);
  });
});

describe("scoreTitleMatch", () => {
  test("ranks an exact title above a containment match", () => {
    const exact = scoreTitleMatch(MUSHOKU[4], "无职转生 第三季 ～到了异世界就拿出真本事～");
    const partial = scoreTitleMatch(MUSHOKU[4], "无职转生 第三季");
    expect(exact).toBeGreaterThan(partial);
    expect(partial).toBeGreaterThan(0);
  });

  test("disqualifies a title with no overlap", () => {
    expect(scoreTitleMatch(MUSHOKU[0], "紫罗兰永恒花园")).toBe(-1);
  });
});

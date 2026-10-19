import { describe, expect, test } from "bun:test";

import { row } from "@/lib/test-utils/genreFixtures";
import { appendUnique, releaseYear, toGenreItems } from "./items";

describe("releaseYear", () => {
  test("the season's year first, then the premiere date's", () => {
    expect(releaseYear({ seasonYear: 2019, startDate: "2018-12-30" })).toBe(2019);
    expect(releaseYear({ seasonYear: null, startDate: "1988-07-16" })).toBe(1988);
    expect(releaseYear({ seasonYear: null, startDate: null })).toBeNull();
    expect(releaseYear({ seasonYear: null, startDate: "soon" })).toBeNull();
  });
});

describe("toGenreItems", () => {
  test("the seasonal item, plus the year and the season", () => {
    const [item] = toGenreItems(
      [row({ anilistId: 7, seasonYear: 1998, season: "WINTER", description: "<p>long synopsis</p>" })],
      "zh",
    );
    expect(item?.id).toBe(7);
    expect(item?.title).toBe("测试番 7");
    expect(item?.year).toBe(1998);
    expect(item?.season).toBe("WINTER");
    expect(item?.synopsis).toBe("");
    expect(item?.haystack).toBe("");
  });

  test("an unknown season is none", () => {
    const [item] = toGenreItems([row({ anilistId: 7, season: "MONSOON" })], "zh");
    expect(item?.season).toBeNull();
  });

  test("one item per show, in the API's order", () => {
    const items = toGenreItems([row({ anilistId: 2 }), row({ anilistId: 1 }), row({ anilistId: 2 })], "en");
    expect(items.map((i) => i.id)).toEqual([2, 1]);
  });
});

describe("appendUnique", () => {
  test("a show already on the page is not drawn twice", () => {
    const first = toGenreItems([row({ anilistId: 1 }), row({ anilistId: 2 })], "zh");
    const next = toGenreItems([row({ anilistId: 2 }), row({ anilistId: 3 })], "zh");
    expect(appendUnique(first, next).map((i) => i.id)).toEqual([1, 2, 3]);
    // The input is left as it was.
    expect(first.map((i) => i.id)).toEqual([1, 2]);
  });
});

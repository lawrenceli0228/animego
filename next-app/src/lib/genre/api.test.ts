import { describe, expect, test } from "bun:test";

import { browseFilter, browsePath, browseQuery, decadeRange, overviewPath, recentFromYear } from "./api";

const RECENT_FROM = 2020;

describe("browseFilter: each grid view as the browse request that lists it", () => {
  test("airing is the genre's RELEASING titles by popularity", () => {
    expect(browseFilter("Action", { kind: "list", list: "airing" }, RECENT_FROM)).toEqual({
      genre: "Action",
      with: null,
      status: "RELEASING",
      yearFrom: null,
      yearTo: null,
      sort: "popularity",
    });
  });

  test("popular is the whole genre by popularity", () => {
    expect(browseFilter("Action", { kind: "list", list: "popular" }, RECENT_FROM)).toMatchObject({
      status: null,
      yearFrom: null,
      yearTo: null,
      sort: "popularity",
    });
  });

  test("recent starts at recentFrom, classic ends in 2009", () => {
    expect(browseFilter("Action", { kind: "list", list: "recent" }, RECENT_FROM)).toMatchObject({ yearFrom: 2020, yearTo: null });
    expect(browseFilter("Action", { kind: "list", list: "classic" }, RECENT_FROM)).toMatchObject({ yearFrom: null, yearTo: 2009 });
  });

  test("top is the score sort", () => {
    expect(browseFilter("Action", { kind: "list", list: "top" }, RECENT_FROM)).toMatchObject({ sort: "score" });
  });

  test("a decade is its ten years; old is 1969 and before", () => {
    expect(browseFilter("Romance", { kind: "decade", decade: "1990" }, RECENT_FROM)).toMatchObject({
      genre: "Romance",
      yearFrom: 1990,
      yearTo: 1999,
    });
    expect(browseFilter("Romance", { kind: "decade", decade: "old" }, RECENT_FROM)).toMatchObject({
      yearFrom: null,
      yearTo: 1969,
    });
  });

  test("with is the second genre", () => {
    expect(browseFilter("Action", { kind: "with", with: "Fantasy" }, RECENT_FROM)).toMatchObject({
      genre: "Action",
      with: "Fantasy",
      sort: "popularity",
    });
  });
});

describe("decadeRange", () => {
  test("every decade key", () => {
    expect(decadeRange("2020")).toEqual({ from: 2020, to: 2029 });
    expect(decadeRange("1970")).toEqual({ from: 1970, to: 1979 });
    expect(decadeRange("old")).toEqual({ from: null, to: 1969 });
  });
});

describe("recentFromYear", () => {
  test("six years before the current year on the site's clock", () => {
    expect(recentFromYear(Date.UTC(2026, 9, 20, 12))).toBe(2020);
  });

  test("the year turns at midnight in Beijing, not in UTC", () => {
    // 2026-12-31 16:30 UTC is 2027-01-01 00:30 in Beijing.
    expect(recentFromYear(Date.UTC(2026, 11, 31, 16, 30))).toBe(2021);
    expect(recentFromYear(Date.UTC(2026, 11, 31, 15, 30))).toBe(2020);
  });
});

describe("the request", () => {
  test("parameters in a fixed order, the page and its size last", () => {
    const filter = browseFilter("Slice of Life", { kind: "decade", decade: "2000" }, RECENT_FROM);
    expect(browseQuery(filter, 2)).toBe("genre=Slice+of+Life&yearFrom=2000&yearTo=2009&sort=popularity&page=2&perPage=36");
    expect(browsePath(browseFilter("Action", { kind: "with", with: "Sci-Fi" }, RECENT_FROM), 1)).toBe(
      "/api/anime/browse?genre=Action&with=Sci-Fi&sort=popularity&page=1&perPage=36",
    );
    expect(browseQuery(browseFilter("Action", { kind: "list", list: "airing" }, RECENT_FROM), 1, 6)).toBe(
      "genre=Action&status=RELEASING&sort=popularity&page=1&perPage=6",
    );
  });

  test("the overview takes the genre enum", () => {
    expect(overviewPath("Mahou Shoujo")).toBe("/api/anime/genre-overview?genre=Mahou+Shoujo");
  });
});

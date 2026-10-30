import { describe, expect, test } from "bun:test";
import { queryFromRecord } from "@/lib/genre/views";
import {
  NO_FILTERS,
  hasFilters,
  parseTopState,
  topApiPath,
  topCanonical,
  topHref,
  topSearch,
  withYear,
  type TopState,
} from "./query";

const q = (record: Record<string, string | string[] | undefined>) => queryFromRecord(record);

describe("parseTopState", () => {
  test("reads the three filters and the view by their slugs, case and spaces aside", () => {
    expect(parseTopState(q({ format: "Movie", genre: " slice-of-life ", season: "FALL", view: "chart" }), 2025)).toEqual({
      year: 2025,
      format: "MOVIE",
      genre: "Slice of Life",
      season: "FALL",
      view: "chart",
    });
  });

  test("nothing asked is the unfiltered ranking in the cover grid", () => {
    expect(parseTopState(q({}), null)).toEqual({ year: null, ...NO_FILTERS, view: "grid" });
  });

  test("a value that is no option is no filter, prototype names included", () => {
    for (const bad of ["constructor", "__proto__", "toString", "hasOwnProperty", "tv_short", "", "hentai"]) {
      const s = parseTopState(q({ format: bad, genre: bad, season: bad, view: bad }), 2024);
      expect(s).toEqual({ year: 2024, ...NO_FILTERS, view: "grid" });
    }
  });

  test("a music video is no format the ranking counts (Music the genre is a genre)", () => {
    expect(parseTopState(q({ format: "music", genre: "music" }), null)).toMatchObject({ format: null, genre: "Music" });
  });

  test("a season only narrows a year's ranking", () => {
    expect(parseTopState(q({ season: "winter" }), null).season).toBeNull();
    expect(parseTopState(q({ season: "winter" }), 2019).season).toBe("WINTER");
  });

  test("a repeated parameter reads as its first value", () => {
    expect(parseTopState(q({ format: ["ova", "tv"] }), null).format).toBe("OVA");
  });
});

describe("addresses", () => {
  const state: TopState = { year: 2019, format: "MOVIE", genre: "Sci-Fi", season: "SPRING", view: "table" };

  test("a link writes the filters in one order, then the view", () => {
    expect(topHref(state)).toBe("/top/2019?format=movie&genre=sci-fi&season=spring&view=table");
    expect(topSearch(state)).toBe("?format=movie&genre=sci-fi&season=spring&view=table");
    expect(topHref({ ...state, view: "grid" })).toBe("/top/2019?format=movie&genre=sci-fi&season=spring");
    expect(topHref({ year: null, ...NO_FILTERS, view: "grid" })).toBe("/top");
  });

  test("the canonical leaves the view out", () => {
    expect(topCanonical(state)).toBe("/top/2019?format=movie&genre=sci-fi&season=spring");
    expect(topCanonical({ year: null, ...NO_FILTERS, view: "chart" })).toBe("/top");
  });

  test("the API request uses the enums and the genre's own name, in one order", () => {
    expect(topApiPath(state)).toBe("/api/anime/top?year=2019&format=MOVIE&season=SPRING&genre=Sci-Fi");
    expect(topApiPath({ year: null, ...NO_FILTERS })).toBe("/api/anime/top");
    expect(topApiPath({ year: null, format: null, genre: "Slice of Life", season: null })).toBe(
      "/api/anime/top?genre=Slice+of+Life",
    );
  });

  test("moving to another year drops the season with the year it belonged to", () => {
    expect(withYear(state, 2020)).toEqual({ ...state, year: 2020, season: null });
    expect(withYear(state, null)).toEqual({ ...state, year: null, season: null });
  });

  test("hasFilters ignores the view", () => {
    expect(hasFilters({ ...NO_FILTERS })).toBe(false);
    expect(hasFilters({ ...NO_FILTERS, genre: "Action" })).toBe(true);
  });
});

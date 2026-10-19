import { describe, expect, test } from "bun:test";

import {
  MAX_GRID_PAGE,
  gridHref,
  gridSearch,
  parseGenreView,
  parseGridPage,
  queryFromRecord,
  sameGridView,
  type GenreView,
} from "./views";

const view = (query: Record<string, string | string[] | undefined>, genre = "Action" as const): GenreView =>
  parseGenreView(queryFromRecord(query), genre);

describe("parseGenreView", () => {
  test("no view in the query is the hub", () => {
    expect(view({})).toEqual({ kind: "hub" });
  });

  test("each list is a grid of that list, page 1", () => {
    for (const list of ["airing", "popular", "recent", "classic", "top"] as const) {
      expect(view({ list })).toEqual({ kind: "grid", view: { kind: "list", list }, page: 1, legacy: false });
    }
  });

  test("each decade, `old` included, is a grid of that decade", () => {
    for (const decade of ["2020", "2010", "2000", "1990", "1980", "1970", "old"] as const) {
      expect(view({ decade })).toEqual({ kind: "grid", view: { kind: "decade", decade }, page: 1, legacy: false });
    }
  });

  test("`with` takes another genre's slug", () => {
    expect(view({ with: "fantasy" })).toEqual({
      kind: "grid",
      view: { kind: "with", with: "Fantasy" },
      page: 1,
      legacy: false,
    });
    expect(view({ with: "slice-of-life" })).toMatchObject({ view: { kind: "with", with: "Slice of Life" } });
    expect(view({ with: "Sci-Fi" })).toMatchObject({ view: { kind: "with", with: "Sci-Fi" } });
  });

  test("`with` the page's own genre, an unknown slug or the adult genre is ignored", () => {
    expect(view({ with: "action" })).toEqual({ kind: "hub" });
    expect(view({ with: "nope" })).toEqual({ kind: "hub" });
    expect(view({ with: "hentai" })).toEqual({ kind: "hub" });
  });

  test("precedence: list, then decade, then with", () => {
    expect(view({ list: "top", decade: "1990", with: "fantasy" })).toMatchObject({ view: { kind: "list", list: "top" } });
    expect(view({ decade: "1990", with: "fantasy" })).toMatchObject({ view: { kind: "decade", decade: "1990" } });
  });

  test("an unknown value is skipped, and the next valid one wins", () => {
    expect(view({ list: "bogus", decade: "1990" })).toMatchObject({ view: { kind: "decade", decade: "1990" } });
    expect(view({ list: "bogus", decade: "1960", with: "romance" })).toMatchObject({
      view: { kind: "with", with: "Romance" },
    });
    expect(view({ list: "bogus", decade: "1960" })).toEqual({ kind: "hub" });
  });

  test("Object.prototype names are not views", () => {
    for (const bad of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(view({ list: bad })).toEqual({ kind: "hub" });
      expect(view({ decade: bad })).toEqual({ kind: "hub" });
      expect(view({ with: bad })).toEqual({ kind: "hub" });
    }
  });

  test("a page goes with the view", () => {
    expect(view({ list: "airing", page: "3" })).toEqual({
      kind: "grid",
      view: { kind: "list", list: "airing" },
      page: 3,
      legacy: false,
    });
  });

  test("the old ?page=N alone is the popular list on the grid, page N", () => {
    expect(view({ page: "2" })).toEqual({ kind: "grid", view: { kind: "list", list: "popular" }, page: 2, legacy: true });
    expect(view({ page: "1" })).toEqual({ kind: "grid", view: { kind: "list", list: "popular" }, page: 1, legacy: true });
  });

  test("a page that is not a page number is ignored", () => {
    for (const page of ["0", "-1", "abc", "2.5", "1e3", "", " "]) {
      expect(view({ page })).toEqual({ kind: "hub" });
      expect(view({ list: "top", page })).toMatchObject({ page: 1 });
    }
  });

  test("a page past the API's ceiling is the ceiling", () => {
    expect(view({ list: "top", page: "999" })).toMatchObject({ page: MAX_GRID_PAGE });
    expect(view({ page: "100000" })).toMatchObject({ page: MAX_GRID_PAGE, legacy: true });
  });

  test("a repeated key reads as its first value", () => {
    expect(view({ list: ["recent", "top"] })).toMatchObject({ view: { kind: "list", list: "recent" } });
  });
});

describe("parseGridPage", () => {
  test("digits from 1 up", () => {
    expect(parseGridPage("1")).toBe(1);
    expect(parseGridPage("12")).toBe(12);
    expect(parseGridPage(null)).toBeNull();
    expect(parseGridPage("0")).toBeNull();
  });
});

describe("grid URLs", () => {
  test("the view's own parameter, and the page past the first", () => {
    expect(gridSearch({ kind: "list", list: "airing" })).toBe("?list=airing");
    expect(gridSearch({ kind: "decade", decade: "old" }, 2)).toBe("?decade=old&page=2");
    expect(gridSearch({ kind: "with", with: "Slice of Life" })).toBe("?with=slice-of-life");
    expect(gridHref("Action", { kind: "list", list: "top" }, 1)).toBe("/genre/action?list=top");
    expect(gridHref("Sci-Fi", { kind: "decade", decade: "1990" }, 3)).toBe("/genre/sci-fi?decade=1990&page=3");
  });

  test("a written URL parses back to its view", () => {
    const views = [
      { kind: "list", list: "classic" },
      { kind: "decade", decade: "1970" },
      { kind: "with", with: "Mahou Shoujo" },
    ] as const;
    for (const v of views) {
      const parsed = parseGenreView(new URLSearchParams(gridSearch(v, 4)), "Action");
      expect(parsed.kind).toBe("grid");
      if (parsed.kind === "grid") {
        expect(sameGridView(parsed.view, v)).toBe(true);
        expect(parsed.page).toBe(4);
      }
    }
  });
});

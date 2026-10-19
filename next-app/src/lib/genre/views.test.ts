import { describe, expect, test } from "bun:test";

import {
  MAX_GRID_PAGE,
  gridHref,
  gridSearch,
  legacyGridPage,
  parseGenreView,
  parseGridPage,
  queryFromRecord,
  sameGridView,
  viewPath,
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

describe("legacyGridPage", () => {
  // The old list had 24 to a page, the grid has 36: old page N starts at
  // title 24(N-1)+1, which the grid holds on page floor(24(N-1)/36)+1.
  test("opens the grid page holding the old page's first title", () => {
    expect(legacyGridPage(1)).toBe(1); // titles 1–24
    expect(legacyGridPage(2)).toBe(1); // 25–48 start on page 1 (1–36)
    expect(legacyGridPage(3)).toBe(2); // 49–72 → page 2 (37–72)
    expect(legacyGridPage(4)).toBe(3); // 73 → page 3 (73–108)
    expect(legacyGridPage(146)).toBe(97);
  });

  test("stays within the grid's own ceiling", () => {
    expect(legacyGridPage(MAX_GRID_PAGE)).toBeLessThanOrEqual(MAX_GRID_PAGE);
    expect(legacyGridPage(MAX_GRID_PAGE)).toBe(133);
  });
});

describe("viewPath", () => {
  test("the hub is the genre's own path", () => {
    expect(viewPath("Action", view({}))).toBe("/genre/action");
    expect(viewPath("Slice of Life", parseGenreView(queryFromRecord({}), "Slice of Life"))).toBe("/genre/slice-of-life");
  });

  test("a grid is its view and page, written one way", () => {
    expect(viewPath("Action", view({ list: "airing" }))).toBe("/genre/action?list=airing");
    expect(viewPath("Action", view({ list: "airing", page: "1" }))).toBe("/genre/action?list=airing");
    expect(viewPath("Action", view({ list: "top", page: "3" }))).toBe("/genre/action?list=top&page=3");
    expect(viewPath("Action", view({ decade: "old", page: "2" }))).toBe("/genre/action?decade=old&page=2");
    expect(viewPath("Action", view({ with: "Fantasy" }))).toBe("/genre/action?with=fantasy");
  });

  test("every other spelling of a view names the same address", () => {
    expect(viewPath("Action", view({ decade: "1990", list: "airing", with: "comedy" }))).toBe(
      "/genre/action?list=airing",
    );
    expect(viewPath("Action", view({ list: ["recent", "top"] }))).toBe("/genre/action?list=recent");
    expect(viewPath("Action", view({ list: "popular", page: "2", utm_source: "x" }))).toBe(
      "/genre/action?list=popular&page=2",
    );
    expect(viewPath("Action", view({ list: "classic", page: "100000" }))).toBe(
      `/genre/action?list=classic&page=${MAX_GRID_PAGE}`,
    );
  });

  test("the old ?page=N is the popularity grid's page holding its first title", () => {
    expect(viewPath("Action", view({ page: "1" }))).toBe("/genre/action?list=popular");
    expect(viewPath("Action", view({ page: "3" }))).toBe("/genre/action?list=popular&page=2");
    expect(viewPath("Action", view({ page: "9999" }))).toBe("/genre/action?list=popular&page=133");
  });
});

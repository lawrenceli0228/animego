import { describe, expect, test } from "bun:test";

import {
  DEFAULT_STATE,
  MAX_QUERY_LENGTH,
  browseSearch,
  browseSearchParams,
  parseBrowseState,
  queryFromRecord,
  sameBrowseState,
  type BrowseState,
} from "./state";

// The URL is the page's shareable state, read by the server for the first
// paint and by the client when a cached page comes back: one parser for both,
// and links written before this page existed must still land somewhere sane.

const parse = (search: string) => parseBrowseState(new URLSearchParams(search));

describe("parseBrowseState", () => {
  test("no query is the default page", () => {
    expect(parse("")).toEqual(DEFAULT_STATE);
  });

  test("reads every parameter", () => {
    expect(
      parse(
        "q=药屋&genre=Action,Comedy&format=TV&status=RELEASING&source=LIGHT_NOVEL&seq=sequel&wd=5&mon=2026-10&hue=blue&sort=score&view=chart",
      ),
    ).toEqual({
      q: "药屋",
      genres: ["Action", "Comedy"],
      format: "TV",
      status: "RELEASING",
      source: "LIGHT_NOVEL",
      seq: "sequel",
      wd: 5,
      mon: "2026-10",
      hue: "blue",
      sort: "score",
      view: "chart",
    });
  });

  test("one genre — the old single-value form — still works", () => {
    expect(parse("genre=Slice+of+Life").genres).toEqual(["Slice of Life"]);
  });

  test("genres keep the order they were picked; unknown and repeated ones are dropped", () => {
    expect(parse("genre=Romance,Hentai,Bogus,Action,Romance").genres).toEqual(["Romance", "Action"]);
  });

  test("the old sorts map to what they meant", () => {
    expect(parse("sort=score").sort).toBe("score");
    expect(parse("sort=title").sort).toBe("title");
    // Grouping by format has no counterpart; it lands on the default.
    expect(parse("sort=format").sort).toBe("pop");
    expect(parse("sort=nonsense").sort).toBe("pop");
  });

  test("malformed values fall back to the default instead of being guessed at", () => {
    const s = parse("format=MUSIC&status=CANCELLED&source=MANGA_ISH&seq=maybe&wd=8&mon=2026-13&hue=pink&view=cards");
    expect(s).toEqual(DEFAULT_STATE);
    expect(parse("wd=0").wd).toBe(0);
    expect(parse("wd=2.5").wd).toBe(0);
    expect(parse("mon=tbd").mon).toBe("tbd");
  });

  test("the old load-more cursor is read past", () => {
    expect(parse("show=60&genre=Action")).toEqual({ ...DEFAULT_STATE, genres: ["Action"] });
  });

  test("an absurdly long query is cut, not rejected", () => {
    expect(parse(`q=${"x".repeat(500)}`).q).toHaveLength(MAX_QUERY_LENGTH);
  });

  test("a server component's searchParams read the same way, first value of a repeat", () => {
    const query = queryFromRecord({ genre: ["Action", "Drama"], sort: "time", missing: undefined });
    expect(parseBrowseState(query)).toEqual({ ...DEFAULT_STATE, genres: ["Action"], sort: "time" });
  });
});

describe("browseSearch", () => {
  test("the default page is the plain URL", () => {
    expect(browseSearch(DEFAULT_STATE)).toBe("");
  });

  test("only what differs from the default is written, in a fixed order", () => {
    const state: BrowseState = { ...DEFAULT_STATE, view: "table", genres: ["Action", "Sci-Fi"], q: "  frieren " };
    expect(browseSearch(state)).toBe("?q=frieren&genre=Action%2CSci-Fi&view=table");
  });

  test("parameters this page does not own survive; `show` does not", () => {
    const params = browseSearchParams({ ...DEFAULT_STATE, sort: "fav" }, "?utm_source=x&show=40&sort=score");
    expect(params.toString()).toBe("utm_source=x&sort=fav");
  });

  test("whatever is written reads back as the same state", () => {
    const states: BrowseState[] = [
      DEFAULT_STATE,
      { ...DEFAULT_STATE, q: "葬送", genres: ["Drama"], wd: 7, sort: "time" },
      { ...DEFAULT_STATE, mon: "tbd", sort: "start", hue: "purple", view: "chart" },
      { ...DEFAULT_STATE, format: "MOVIE", status: "FINISHED", source: "OTHER", seq: "new", sort: "title" },
    ];
    for (const s of states) expect(parse(browseSearch(s))).toEqual(s);
  });
});

describe("sameBrowseState", () => {
  test("compares the search box as typed, trimmed", () => {
    expect(sameBrowseState({ ...DEFAULT_STATE, q: "abc " }, { ...DEFAULT_STATE, q: "abc" })).toBe(true);
  });

  test("genre order matters — it is the order of the tags", () => {
    const a = { ...DEFAULT_STATE, genres: ["Action", "Drama"] };
    const b = { ...DEFAULT_STATE, genres: ["Drama", "Action"] };
    expect(sameBrowseState(a, b)).toBe(false);
  });

  test("any field differing is a different page", () => {
    expect(sameBrowseState(DEFAULT_STATE, { ...DEFAULT_STATE, view: "chart" })).toBe(false);
    expect(sameBrowseState(DEFAULT_STATE, { ...DEFAULT_STATE, wd: 1 })).toBe(false);
  });
});

describe("query values that name Object.prototype members", () => {
  // A bare lookup in the legacy-sort table used to return Object's own
  // members, which the server cannot hand to the client tree (a 500).
  test("fall back to the default sort, and every value stays a string", () => {
    for (const value of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      const state = parse(`sort=${value}&view=${value}&hue=${value}&source=${value}&format=${value}&genre=${value}`);
      expect(state.sort).toBe("pop");
      expect(state.view).toBe("grid");
      expect(state.hue).toBe("");
      expect(state.source).toBe("");
      expect(state.format).toBe("");
      expect(state.genres).toEqual([]);
      expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    }
  });
});

describe("the search box's length cap", () => {
  test("cuts at a whole character, never inside an emoji", () => {
    const state = parse(`q=${encodeURIComponent("x".repeat(99) + "😀😀")}`);
    expect(Array.from(state.q)).toHaveLength(100);
    expect(state.q.endsWith("😀")).toBe(true);
    expect(parse(browseSearch(state).slice(1)).q).toBe(state.q);
  });
});

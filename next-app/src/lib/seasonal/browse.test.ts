import { describe, expect, test } from "bun:test";

import { HOUR_MS, NOW, item } from "@/lib/test-utils/seasonalItems";
import {
  activeTags,
  browseItems,
  clearFilters,
  facetsOf,
  hueOptionsOf,
  matchesState,
  resetSheet,
  settleState,
  sheetFilterCount,
  sortItems,
  sourceGroupOf,
  stateForOtherSeason,
  toggleGenre,
  toggleHue,
  toggleMonth,
  toggleWeekday,
  withoutTag,
} from "./browse";
import { DEFAULT_STATE, type BrowseState } from "./state";

const s = (patch: Partial<BrowseState>): BrowseState => ({ ...DEFAULT_STATE, ...patch });
const ids = (list: { id: number }[]) => list.map((i) => i.id);

/** Friday 22:00 and Saturday 00:30 in Beijing (14:00 and 16:30 UTC on Friday). */
const FRI_22 = Date.UTC(2026, 9, 16, 14, 0);
const SAT_0030 = Date.UTC(2026, 9, 16, 16, 30);

describe("sourceGroupOf", () => {
  test("comics read as manga, visual novels as games, the rest of the record as other", () => {
    expect(sourceGroupOf("MANGA")).toBe("MANGA");
    expect(sourceGroupOf("COMIC")).toBe("MANGA");
    expect(sourceGroupOf("VISUAL_NOVEL")).toBe("GAME");
    expect(sourceGroupOf("VIDEO_GAME")).toBe("GAME");
    expect(sourceGroupOf("MULTIMEDIA_PROJECT")).toBe("OTHER");
    expect(sourceGroupOf("ORIGINAL")).toBe("ORIGINAL");
    expect(sourceGroupOf(null)).toBeNull();
  });
});

describe("hueOptionsOf", () => {
  test("one dot per family present, in circle order, colourless covers in none", () => {
    const shows = [
      item({ id: 1, hue: 245 }),
      item({ id: 2, hue: 20 }),
      item({ id: 3, hue: 250 }),
      item({ id: 4, hue: null }),
      item({ id: 5, hue: 350 }),
    ];
    expect(hueOptionsOf(shows)).toEqual([
      { key: "red", hue: 20, count: 2 },
      { key: "blue", hue: 245, count: 2 },
    ]);
    expect(hueOptionsOf([item({ id: 6 })])).toEqual([]);
  });
});

describe("matchesState", () => {
  const shows = [
    item({ id: 1, haystack: "药屋少女的呢喃\n薬屋のひとりごと\nkusuriya no hitorigoto", genres: ["Drama", "Mystery"], format: "TV", status: "RELEASING", source: "LIGHT_NOVEL", sequel: true, next: { at: FRI_22, ep: 4 }, start: "2026-10-02", hue: 76 }),
    item({ id: 2, haystack: "黑色五叶草\nblack clover", genres: ["Action", "Comedy"], format: "TV", status: "RELEASING", source: "MANGA", sequel: false, next: { at: SAT_0030, ep: 3 }, start: "2026-10-03", hue: 245 }),
    item({ id: 3, haystack: "剧场版\nmovie", genres: ["Action"], format: "MOVIE", status: "NOT_YET_RELEASED", source: "ORIGINAL", sequel: null, start: null, hue: null }),
  ];
  const only = (state: BrowseState, mode: "weekday" | "month" = "weekday") =>
    ids(shows.filter((x) => matchesState(x, state, mode)));

  test("search matches any of the titles, case-insensitively", () => {
    expect(only(s({ q: "薬屋" }))).toEqual([1]);
    expect(only(s({ q: "  Black " }))).toEqual([2]);
    expect(only(s({ q: "HITORIGOTO" }))).toEqual([1]);
  });

  test("genres combine with AND", () => {
    expect(only(s({ genres: ["Action"] }))).toEqual([2, 3]);
    expect(only(s({ genres: ["Action", "Comedy"] }))).toEqual([2]);
  });

  test("format, status and source group", () => {
    expect(only(s({ format: "MOVIE" }))).toEqual([3]);
    expect(only(s({ status: "RELEASING" }))).toEqual([1, 2]);
    expect(only(s({ source: "MANGA" }))).toEqual([2]);
  });

  test("new or sequel: a show the API said nothing about is neither", () => {
    expect(only(s({ seq: "new" }))).toEqual([2]);
    expect(only(s({ seq: "sequel" }))).toEqual([1]);
  });

  test("a weekday is the Beijing day the next episode airs — 00:30 Saturday is Saturday", () => {
    expect(only(s({ wd: 5 }))).toEqual([1]);
    expect(only(s({ wd: 6 }))).toEqual([2]);
  });

  test("a weekday is an airing show's slot: an upcoming premiere on that day is not in it", () => {
    const premiere = item({ id: 9, status: "NOT_YET_RELEASED", next: { at: FRI_22, ep: 1 } });
    expect(matchesState(premiere, s({ wd: 5 }), "weekday")).toBe(false);
  });

  test("a weekday means nothing in month mode, a month nothing in weekday mode", () => {
    expect(only(s({ wd: 5 }), "month")).toEqual([1, 2, 3]);
    expect(only(s({ mon: "2026-10" }), "weekday")).toEqual([1, 2, 3]);
  });

  test("a month is the premiere month; tbd is no date", () => {
    expect(only(s({ mon: "2026-10" }), "month")).toEqual([1, 2]);
    expect(only(s({ mon: "tbd" }), "month")).toEqual([3]);
  });

  test("a hue family; a colourless cover is in none", () => {
    expect(only(s({ hue: "yellow" }))).toEqual([1]);
    expect(only(s({ hue: "blue" }))).toEqual([2]);
  });
});

describe("sortItems", () => {
  const shows = [
    item({ id: 1, rank: 0, popularity: 500, score: 80, favourites: 5, next: { at: NOW + 50 * HOUR_MS, ep: 2 }, start: "2026-10-05", titleRank: 2 }),
    item({ id: 2, rank: 1, popularity: 900, score: 80, favourites: 50, next: { at: NOW + 2 * HOUR_MS, ep: 7 }, start: "2026-10-01", titleRank: 0 }),
    item({ id: 3, rank: 2, popularity: null, score: null, favourites: null, next: null, start: null, titleRank: 1 }),
    item({ id: 4, rank: 3, popularity: 700, score: 91, favourites: 20, next: { at: NOW + 30 * HOUR_MS, ep: 1 }, start: "2026-10-20", titleRank: 3 }),
  ];

  test("popularity, most first, unknown last", () => {
    expect(ids(sortItems(shows, "pop"))).toEqual([2, 4, 1, 3]);
  });

  test("score, ties broken by popularity", () => {
    expect(ids(sortItems(shows, "score"))).toEqual([4, 2, 1, 3]);
  });

  test("favourites", () => {
    expect(ids(sortItems(shows, "fav"))).toEqual([2, 4, 1, 3]);
  });

  test("next episode, soonest first, nothing scheduled last", () => {
    expect(ids(sortItems(shows, "next"))).toEqual([2, 4, 1, 3]);
  });

  test("air time is the place in the week, not the date", () => {
    // NOW is Friday 20:00. +2h = Friday 22:00, +30h = Sunday 02:00, +50h = Sunday 22:00.
    const week = [
      item({ id: 1, next: { at: NOW + 50 * HOUR_MS, ep: 2 } }),
      item({ id: 2, next: { at: NOW + 2 * HOUR_MS + 7 * 24 * HOUR_MS, ep: 7 } }),
      item({ id: 3, next: { at: NOW + 30 * HOUR_MS, ep: 1 } }),
    ];
    expect(ids(sortItems(week, "time"))).toEqual([2, 3, 1]);
  });

  test("air time places shows without a weekly slot last", () => {
    const week = [
      item({ id: 1, status: "NOT_YET_RELEASED", next: { at: NOW + 2 * HOUR_MS, ep: 1 }, popularity: 9 }),
      item({ id: 2, next: { at: NOW + 50 * HOUR_MS, ep: 2 } }),
    ];
    expect(ids(sortItems(week, "time"))).toEqual([2, 1]);
  });

  test("start date", () => {
    expect(ids(sortItems(shows, "start"))).toEqual([2, 1, 4, 3]);
  });

  test("title follows the collation decided on the server", () => {
    expect(ids(sortItems(shows, "title"))).toEqual([2, 3, 1, 4]);
  });

  test("an all-unknown column keeps the API order, so the default sort without data is the old page", () => {
    const blind = [item({ id: 7, rank: 0 }), item({ id: 5, rank: 1 }), item({ id: 6, rank: 2 })];
    expect(ids(sortItems(blind, "pop"))).toEqual([7, 5, 6]);
  });

  test("returns a new array and leaves the input alone", () => {
    const before = ids(shows);
    const out = sortItems(shows, "score");
    expect(out).not.toBe(shows);
    expect(ids(shows)).toEqual(before);
  });
});

describe("browseItems", () => {
  test("filters, then sorts", () => {
    const shows = [
      item({ id: 1, genres: ["Action"], popularity: 1 }),
      item({ id: 2, genres: ["Drama"], popularity: 9 }),
      item({ id: 3, genres: ["Action"], popularity: 5 }),
    ];
    expect(ids(browseItems(shows, s({ genres: ["Action"] }), "month"))).toEqual([3, 1]);
  });
});

describe("facetsOf / settleState", () => {
  const legacy = [item({ id: 1 }), item({ id: 2 })];
  const rich = [
    item({ id: 1, favourites: 3, next: { at: NOW, ep: 2 }, start: "2026-10-01", source: "MANGA", sequel: true }),
  ];

  test("without the browse fields the page offers only what the API can answer", () => {
    expect(facetsOf(legacy)).toEqual({ sorts: ["pop", "score", "title"], source: false, sequel: false });
    expect(facetsOf(rich)).toEqual({
      sorts: ["pop", "score", "fav", "next", "time", "start", "title"],
      source: true,
      sequel: true,
    });
  });

  test("the sequel filter waits until some show is known to be one — false is also 'not known yet'", () => {
    const unknown = [item({ id: 1, sequel: false }), item({ id: 2, sequel: false })];
    expect(facetsOf(unknown).sequel).toBe(false);
    expect(facetsOf([...unknown, item({ id: 3, sequel: true })]).sequel).toBe(true);
  });

  test("a URL asking for more than the data can do lands on a working page", () => {
    const state = s({ sort: "fav", source: "MANGA", seq: "new", wd: 3 });
    expect(settleState(state, facetsOf(legacy), "month")).toEqual(DEFAULT_STATE);
  });

  test("the weekday filter survives in weekday mode, the month filter in month mode", () => {
    const f = facetsOf(rich);
    expect(settleState(s({ wd: 3, mon: "2026-10", sort: "time" }), f, "weekday")).toEqual(s({ wd: 3, sort: "time" }));
    expect(settleState(s({ wd: 3, mon: "2026-10", sort: "start" }), f, "month")).toEqual(s({ mon: "2026-10", sort: "start" }));
  });

  test("a state that needs no change comes back as the same object", () => {
    const state = s({ genres: ["Action"] });
    expect(settleState(state, facetsOf(rich), "weekday")).toBe(state);
  });
});

describe("state changes", () => {
  test("a weekday bar filters and sorts by air time; pressing it again undoes both", () => {
    const on = toggleWeekday(s({ mon: "2026-10" }), 3);
    expect(on).toEqual(s({ wd: 3, sort: "time" }));
    expect(toggleWeekday(on, 3)).toEqual(DEFAULT_STATE);
  });

  test("turning a weekday off keeps a sort the reader picked since", () => {
    expect(toggleWeekday(s({ wd: 3, sort: "score" }), 3)).toEqual(s({ sort: "score" }));
  });

  test("another weekday moves the filter and keeps sorting by air time", () => {
    expect(toggleWeekday(s({ wd: 3, sort: "time" }), 5)).toEqual(s({ wd: 5, sort: "time" }));
  });

  test("a month bar filters and sorts by start date; pressing it again undoes both", () => {
    const on = toggleMonth(s({ wd: 2 }), "tbd");
    expect(on).toEqual(s({ mon: "tbd", sort: "start" }));
    expect(toggleMonth(on, "tbd")).toEqual(DEFAULT_STATE);
  });

  test("genres and hues toggle", () => {
    expect(toggleGenre(toggleGenre(DEFAULT_STATE, "Action"), "Drama").genres).toEqual(["Action", "Drama"]);
    expect(toggleGenre(s({ genres: ["Action", "Drama"] }), "Action").genres).toEqual(["Drama"]);
    expect(toggleHue(DEFAULT_STATE, "blue").hue).toBe("blue");
    expect(toggleHue(s({ hue: "blue" }), "blue").hue).toBe("");
  });

  test("clear all keeps the view and the reader's sort, drops a sort that belonged to a filter", () => {
    const busy = s({ q: "x", genres: ["Action"], format: "TV", status: "FINISHED", source: "GAME", seq: "new", hue: "red", view: "table" });
    expect(clearFilters({ ...busy, sort: "score" })).toEqual(s({ view: "table", sort: "score" }));
    expect(clearFilters({ ...busy, wd: 2, sort: "time" })).toEqual(s({ view: "table" }));
  });

  test("the sheet's reset also puts the sort back", () => {
    expect(resetSheet(s({ genres: ["Action"], sort: "score", view: "chart" }))).toEqual(s({ view: "chart" }));
  });

  test("a link to another season drops this season's calendar", () => {
    expect(stateForOtherSeason(s({ wd: 3, sort: "time", genres: ["Action"], view: "chart" }))).toEqual(
      s({ genres: ["Action"], view: "chart" }),
    );
    expect(stateForOtherSeason(s({ mon: "tbd", sort: "start" })).sort).toBe("pop");
    expect(stateForOtherSeason(s({ sort: "fav" })).sort).toBe("fav");
  });
});

describe("the tag row", () => {
  const busy = s({
    q: " 药屋 ",
    genres: ["Action", "Drama"],
    format: "TV",
    status: "RELEASING",
    source: "MANGA",
    seq: "sequel",
    wd: 5,
    hue: "blue",
    sort: "time",
  });

  test("one tag per active filter, in bar order", () => {
    expect(activeTags(busy).map((t) => `${t.kind}:${t.value}`)).toEqual([
      "q:药屋",
      "genre:Action",
      "genre:Drama",
      "format:TV",
      "status:RELEASING",
      "source:MANGA",
      "seq:sequel",
      "wd:5",
      "hue:blue",
    ]);
    expect(activeTags(DEFAULT_STATE)).toEqual([]);
  });

  test("removing a tag removes that filter only; the weekday takes its sort with it", () => {
    expect(withoutTag(busy, { kind: "genre", value: "Action" }).genres).toEqual(["Drama"]);
    expect(withoutTag(busy, { kind: "q", value: "药屋" }).q).toBe("");
    const noDay = withoutTag(busy, { kind: "wd", value: 5 });
    expect(noDay.wd).toBe(0);
    expect(noDay.sort).toBe("pop");
    expect(noDay.hue).toBe("blue");
    const noMonth = withoutTag(s({ mon: "2026-10", sort: "start" }), { kind: "mon", value: "2026-10" });
    expect(noMonth).toEqual(DEFAULT_STATE);
    for (const kind of ["format", "status", "source", "seq", "hue"] as const) {
      const tag = activeTags(busy).find((t) => t.kind === kind);
      expect(tag).toBeDefined();
      expect(activeTags(withoutTag(busy, tag!)).some((t) => t.kind === kind)).toBe(false);
    }
  });

  test("the phone's filter badge counts what the sheet controls", () => {
    expect(sheetFilterCount(busy)).toBe(4);
    expect(sheetFilterCount(DEFAULT_STATE)).toBe(0);
  });
});

describe("the weekday filter and the air-time sort on the reader's clock", () => {
  const LOS_ANGELES = () => -7 * 60;
  // a: Monday 00:30 in Beijing = Sunday 09:30 in Los Angeles.
  // b: Sunday 20:00 in Beijing = Sunday 05:00 in Los Angeles.
  const a = item({ id: 1, popularity: 10, next: { at: Date.UTC(2026, 9, 18, 16, 30), ep: 2 } });
  const b = item({ id: 2, popularity: 5, next: { at: Date.UTC(2026, 9, 18, 12, 0), ep: 2 } });
  const sunday: BrowseState = { ...DEFAULT_STATE, wd: 7, sort: "time" };

  test("Sunday holds one show in Beijing and both in Los Angeles", () => {
    expect(browseItems([a, b], sunday, "weekday").map((i) => i.id)).toEqual([2]);
    expect(browseItems([a, b], sunday, "weekday", LOS_ANGELES).map((i) => i.id)).toEqual([2, 1]);
    expect(matchesState(a, sunday, "weekday", LOS_ANGELES)).toBe(true);
    expect(matchesState(a, sunday, "weekday")).toBe(false);
  });

  test("air time orders by the reader's week: Beijing's Monday slot comes before its Sunday one in Los Angeles' Sunday", () => {
    // In Beijing, b (Sunday 20:00) is late in the week and a (Monday 00:30) first.
    expect(sortItems([a, b], "time").map((i) => i.id)).toEqual([1, 2]);
    // In Los Angeles both are Sunday: b at 05:00, a at 09:30.
    expect(sortItems([a, b], "time", LOS_ANGELES).map((i) => i.id)).toEqual([2, 1]);
  });
});

describe("the next-episode sort against the clock", () => {
  // A's next episode passed long ago (its row has not synced since); B's is in two hours.
  const a = item({ id: 1, popularity: 50, next: { at: NOW - 20 * 24 * HOUR_MS, ep: 4 } });
  const b = item({ id: 2, popularity: 10, next: { at: NOW + 2 * HOUR_MS, ep: 6 } });
  const c = item({ id: 3, popularity: 30 });

  test("an episode already out sorts with the unknowns, after every one still to come", () => {
    expect(sortItems([a, b, c], "next", undefined, NOW).map((i) => i.id)).toEqual([2, 1, 3]);
    const state: BrowseState = { ...DEFAULT_STATE, sort: "next" };
    expect(browseItems([a, b, c], state, "weekday", undefined, NOW).map((i) => i.id)).toEqual([2, 1, 3]);
  });
});

describe("the air-time sort needs a weekly slot", () => {
  test("a season of first episodes still to premiere offers no air-time sort", () => {
    const premieres = [1, 2, 3].map((id) => item({ id, status: "NOT_YET_RELEASED", next: { at: NOW + id * HOUR_MS, ep: 1 } }));
    expect(facetsOf(premieres).sorts).not.toContain("time");
    expect(facetsOf(premieres).sorts).toContain("next");
    const airing = [...premieres, item({ id: 9, status: "RELEASING", next: { at: NOW + HOUR_MS, ep: 3 } })];
    expect(facetsOf(airing).sorts).toContain("time");
  });
});

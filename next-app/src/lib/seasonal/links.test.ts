import { describe, expect, test } from "bun:test";

import { seasonHref, yearOptions } from "./links";
import { DEFAULT_STATE } from "./state";

describe("yearOptions", () => {
  test("next year down to 2000, newest first — the range the old season nav offered", () => {
    const years = yearOptions(2026, 2026);
    expect(years[0]).toBe(2027);
    expect(years[years.length - 1]).toBe(2000);
    expect(years).toHaveLength(28);
  });

  test("a year the route accepts outside that range is still listed, in order", () => {
    expect(yearOptions(2099, 2026).slice(0, 2)).toEqual([2099, 2027]);
    expect(yearOptions(1995, 2026).at(-1)).toBe(1995);
  });
});

describe("seasonHref", () => {
  test("the plain season page is a plain URL", () => {
    expect(seasonHref("fall", 2026, DEFAULT_STATE)).toBe("/seasonal/fall/2026");
  });

  test("filters travel; this season's weekday, month and the sorts they imply do not", () => {
    const state = { ...DEFAULT_STATE, genres: ["Action"], wd: 5, sort: "time" as const, view: "chart" as const };
    expect(seasonHref("winter", 2027, state)).toBe("/seasonal/winter/2027?genre=Action&view=chart");
    expect(seasonHref("spring", 2026, { ...DEFAULT_STATE, mon: "tbd", sort: "start" })).toBe("/seasonal/spring/2026");
    expect(seasonHref("spring", 2026, { ...DEFAULT_STATE, sort: "score" })).toBe("/seasonal/spring/2026?sort=score");
  });
});

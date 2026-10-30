import { describe, expect, test } from "bun:test";
import { STRIP_YEARS, isRankedYear, parseTopYear, parseTopYears, siteYear, stripYears, withYearListed } from "./years";

describe("siteYear", () => {
  test("turns over at midnight in China, eight hours before UTC does", () => {
    expect(siteYear(Date.parse("2026-12-31T15:59:59Z"))).toBe(2026);
    expect(siteYear(Date.parse("2026-12-31T16:00:00Z"))).toBe(2027);
  });
});

describe("parseTopYears", () => {
  test("keeps valid years once each, newest first", () => {
    expect(
      parseTopYears([
        { year: 2019, count: 5 },
        { year: 2024, count: 300 },
        { year: 2019, count: 9 },
        { year: "2020", count: 1 },
        { year: 2021, count: 0 },
        null,
        { year: 1999.5, count: 3 },
      ]),
    ).toEqual([
      { year: 2024, count: 300 },
      { year: 2019, count: 5 },
    ]);
    expect(parseTopYears(null)).toEqual([]);
    expect(parseTopYears({ data: [] })).toEqual([]);
  });
});

describe("stripYears", () => {
  const years = [2026, 2025, 2024, 2020, 2014, 2013, 2001, 1975].map((year) => ({ year, count: 10 }));

  test("the last thirteen years that have a ranking, and every ranked year before them", () => {
    expect(stripYears(years, 2026)).toEqual({ recent: [2026, 2025, 2024, 2020, 2014], older: [2013, 2001, 1975] });
  });

  test("a year with nothing ranked yet (a new January) has no cell", () => {
    expect(stripYears(years, 2027).recent).toEqual([2026, 2025, 2024, 2020]);
    expect(stripYears(years, 2027).older).toEqual([2014, 2013, 2001, 1975]);
  });

  test("without an answer the strip still offers the last thirteen years", () => {
    const s = stripYears(null, 2026);
    expect(s.recent).toHaveLength(STRIP_YEARS);
    expect(s.recent[0]).toBe(2026);
    expect(s.recent[STRIP_YEARS - 1]).toBe(2014);
    expect(s.older).toEqual([]);
  });

  test("isRankedYear", () => {
    expect(isRankedYear(years, 2001)).toBe(true);
    expect(isRankedYear(years, 2002)).toBe(false);
  });
});

describe("parseTopYear", () => {
  test("four digits in the hub range only", () => {
    expect(parseTopYear("2019")).toBe(2019);
    expect(parseTopYear("019")).toBeNull();
    expect(parseTopYear("1850")).toBeNull();
    expect(parseTopYear("2019.0")).toBeNull();
    expect(parseTopYear("constructor")).toBeNull();
  });
});

describe("withYearListed", () => {
  test("adds a year the list lags behind on, in its place; leaves a listed one alone", () => {
    const years = [{ year: 2020, count: 3 }, { year: 2010, count: 2 }];
    expect(withYearListed(years, 2015, 7)).toEqual([{ year: 2020, count: 3 }, { year: 2015, count: 7 }, { year: 2010, count: 2 }]);
    expect(withYearListed(years, 2020, 9)).toEqual(years);
  });
});

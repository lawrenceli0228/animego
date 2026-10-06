import { describe, expect, test } from "bun:test";
import { nextSeasonOf, seasonHref, seasonOf, startMonthLabel } from "./season";

// The schedule page's last box points at next season's new shows. Which
// season that is, where its page lives and when it starts are all derived
// from the date, never pinned — sitemap.ts once pinned spring/2026 and was
// still pointing crawlers at it in August.

describe("seasonOf", () => {
  test("quarters map to AniList seasons", () => {
    expect(seasonOf(new Date(2026, 0, 15))).toEqual({ season: "WINTER", year: 2026 });
    expect(seasonOf(new Date(2026, 5, 30))).toEqual({ season: "SPRING", year: 2026 });
    expect(seasonOf(new Date(2026, 8, 24))).toEqual({ season: "SUMMER", year: 2026 });
    expect(seasonOf(new Date(2026, 9, 6))).toEqual({ season: "FALL", year: 2026 });
  });
});

describe("nextSeasonOf", () => {
  test("steps one season, rolling the year after fall", () => {
    expect(nextSeasonOf({ season: "SUMMER", year: 2026 })).toEqual({ season: "FALL", year: 2026 });
    expect(nextSeasonOf({ season: "FALL", year: 2026 })).toEqual({ season: "WINTER", year: 2027 });
  });
});

describe("seasonHref", () => {
  test("is the seasonal route's lower-case slug", () => {
    expect(seasonHref({ season: "WINTER", year: 2027 })).toBe("/seasonal/winter/2027");
  });
});

describe("startMonthLabel", () => {
  test("names the season's first month in the reader's language", () => {
    expect(startMonthLabel("FALL", "zh")).toBe("10 月");
    expect(startMonthLabel("WINTER", "zh-Hant")).toBe("1 月");
    expect(startMonthLabel("SPRING", "en")).toBe("April");
  });
});

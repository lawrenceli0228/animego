import { describe, expect, test } from "bun:test";
import { fillTemplate, formatCommunityDate, statusBreakdown } from "./format";

const NOW = Date.UTC(2026, 9, 9, 4, 0); // 2026-10-09 12:00 in Shanghai

describe("formatCommunityDate", () => {
  test("this year: month and day, in the site's zone", () => {
    expect(formatCommunityDate("2026-10-04T08:00:00Z", "zh", NOW)).toBe("10 月 4 日");
    expect(formatCommunityDate("2026-10-04T08:00:00Z", "zh-Hant", NOW)).toBe("10 月 4 日");
    expect(formatCommunityDate("2026-10-04T08:00:00Z", "en", NOW)).toBe("Oct 4");
  });

  test("the day turns at midnight Shanghai, not UTC", () => {
    // 2026-10-03 17:30 UTC is already 10-04 in Shanghai.
    expect(formatCommunityDate("2026-10-03T17:30:00Z", "zh", NOW)).toBe("10 月 4 日");
  });

  test("another year carries the year", () => {
    expect(formatCommunityDate("2025-08-30T00:00:00Z", "zh", NOW)).toBe("2025 年 8 月 30 日");
    expect(formatCommunityDate("2025-08-30T00:00:00Z", "en", NOW)).toBe("Aug 30, 2025");
  });

  test("garbage in, nothing out", () => {
    expect(formatCommunityDate("not a date", "zh", NOW)).toBe("");
  });
});

test("statusBreakdown keeps the non-zero statuses, most common first", () => {
  expect(statusBreakdown({ watching: 1, completed: 3, planToWatch: 0, dropped: 1 })).toEqual([
    { status: "completed", count: 3 },
    { status: "watching", count: 1 },
    { status: "dropped", count: 1 },
  ]);
  expect(statusBreakdown({ watching: 0, completed: 0, planToWatch: 0, dropped: 0 })).toEqual([]);
});

test("fillTemplate fills {{name}} and leaves unknown names", () => {
  expect(fillTemplate("{{n}} 人{{status}}", { n: 2, status: "看完" })).toBe("2 人看完");
  expect(fillTemplate("{{missing}}", {})).toBe("{{missing}}");
});

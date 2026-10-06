import { describe, expect, test } from "bun:test";
import { BAR_MAX_PX, BAR_MIN_PX, addDays, barHeight, leadOf, monthDay, weekKeys, weekdayShort } from "./week";

// The schedule page always shows seven days starting from the API's "today",
// including days the API has no group for. Everything here is date
// arithmetic on `YYYY-MM-DD` keys — no clock, no time zone — so the tabs come
// out the same on the server and in every browser.

describe("addDays", () => {
  test("steps across month and year boundaries", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });

  test("zero is the same day; an invalid key stays empty", () => {
    expect(addDays("2026-10-06", 0)).toBe("2026-10-06");
    expect(addDays("not-a-day", 1)).toBe("");
  });
});

describe("weekKeys", () => {
  test("is seven consecutive days starting today", () => {
    expect(weekKeys("2026-09-27")).toEqual([
      "2026-09-27",
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
    ]);
  });

  test("no today, no week", () => {
    // /api/anime/schedule failing comes back as { today: "" }. Seven tabs of
    // "0" would read as "nothing airs this week", which is a different claim.
    expect(weekKeys("")).toEqual([]);
  });
});

describe("monthDay", () => {
  test("is M/D without padding", () => {
    expect(monthDay("2026-09-03")).toBe("9/3");
    expect(monthDay("2026-10-12")).toBe("10/12");
    expect(monthDay("garbage")).toBe("");
  });
});

describe("weekdayShort", () => {
  test("one character in Chinese, the three-letter name in English", () => {
    expect(weekdayShort(4, "zh")).toBe("四");
    expect(weekdayShort(0, "zh-Hant")).toBe("日");
    expect(weekdayShort(1, "en")).toBe("Mon");
    expect(weekdayShort(9, "en")).toBe("");
  });
});

describe("leadOf — whose colour the day wears", () => {
  const row = (anilistId: number, averageScore: number | null) => ({ anilistId, averageScore });

  test("the best-rated show leads", () => {
    expect(leadOf([row(1, 70), row(2, 88), row(3, 81)])?.anilistId).toBe(2);
  });

  test("a tie goes to the earlier airing (input order)", () => {
    expect(leadOf([row(1, 80), row(2, 80)])?.anilistId).toBe(1);
  });

  test("unrated shows only lead when nobody is rated", () => {
    expect(leadOf([row(1, null), row(2, 64)])?.anilistId).toBe(2);
    expect(leadOf([row(1, null), row(2, null)])?.anilistId).toBe(1);
  });

  test("an empty day has no lead", () => {
    expect(leadOf([])).toBeNull();
  });
});

describe("barHeight", () => {
  test("the busiest day fills the bar; the rest scale against it", () => {
    expect(barHeight(20, 20)).toBe(BAR_MAX_PX);
    expect(barHeight(10, 20)).toBe(Math.round(BAR_MAX_PX / 2));
  });

  test("a quiet day still draws a visible stub, an empty one too", () => {
    expect(barHeight(1, 40)).toBe(BAR_MIN_PX);
    expect(barHeight(0, 20)).toBe(BAR_MIN_PX);
  });

  test("a week with nothing in it does not divide by zero", () => {
    expect(barHeight(0, 0)).toBe(BAR_MIN_PX);
  });
});

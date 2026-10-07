import { describe, expect, test } from "bun:test";
import {
  SITE_TZ,
  clockParts,
  dayHeader,
  fillTemplate,
  hhmm,
  nextDayKey,
  parseDayKey,
  weekdayLabel,
  weekdayTime,
} from "./time";

describe("nextDayKey", () => {
  test("the day after, across a month and a year", () => {
    expect(nextDayKey("2026-10-10")).toBe("2026-10-11");
    expect(nextDayKey("2026-10-31")).toBe("2026-11-01");
    expect(nextDayKey("2026-12-31")).toBe("2027-01-01");
    expect(nextDayKey("2028-02-28")).toBe("2028-02-29");
  });

  test("nothing for a key that is not a real day", () => {
    expect(nextDayKey("")).toBeNull();
    expect(nextDayKey("2026-02-30")).toBeNull();
    expect(nextDayKey("tomorrow")).toBeNull();
  });
});

// Every string here is rendered during hydration by a client component, so it
// has to come out identical from Node's ICU on the server and the browser's
// ICU on the client. That is why nothing below asks Intl for a *localised*
// string: Node renders zh-CN "周日19:00" with no space where Bun and Chrome
// put one. Only numeric parts come from Intl; the words come from tables.

// 2026-09-27 is a Sunday. 11:00Z = 19:00 in Shanghai.
const SUN_1900_CST = Date.UTC(2026, 8, 27, 11, 0);

describe("clockParts", () => {
  test("reads the wall clock in the given zone", () => {
    expect(clockParts(SUN_1900_CST, SITE_TZ)).toEqual({
      dayKey: "2026-09-27",
      weekday: 0,
      hh: "19",
      mm: "00",
    });
  });

  test("midnight is 00, never 24", () => {
    const midnightCst = Date.UTC(2026, 8, 27, 16, 0);
    expect(clockParts(midnightCst, SITE_TZ)).toMatchObject({ dayKey: "2026-09-28", hh: "00", weekday: 1 });
  });

  test("the same instant is a different day in another zone", () => {
    expect(clockParts(SUN_1900_CST, "America/Los_Angeles").dayKey).toBe("2026-09-27");
    expect(clockParts(Date.UTC(2026, 8, 27, 17, 0), "UTC").dayKey).toBe("2026-09-27");
    expect(clockParts(Date.UTC(2026, 8, 27, 17, 0), SITE_TZ).dayKey).toBe("2026-09-28");
  });
});

describe("hhmm / weekdayTime", () => {
  test("24-hour clock with zero padding", () => {
    expect(hhmm(Date.UTC(2026, 8, 27, 1, 5), SITE_TZ)).toBe("09:05");
  });

  test("weekday words come from the language's table", () => {
    expect(weekdayTime(SUN_1900_CST, SITE_TZ, "zh")).toBe("周日 19:00");
    expect(weekdayTime(SUN_1900_CST, SITE_TZ, "zh-Hant")).toBe("週日 19:00");
    expect(weekdayTime(SUN_1900_CST, SITE_TZ, "en")).toBe("Sun 19:00");
  });
});

describe("dayHeader", () => {
  test("formats a YYYY-MM-DD key without consulting any time zone", () => {
    expect(dayHeader("2026-09-24", "zh")).toBe("周四 9月24日");
    expect(dayHeader("2026-09-24", "zh-Hant")).toBe("週四 9月24日");
    expect(dayHeader("2026-09-24", "en")).toBe("Thu, Sep 24");
  });

  test("an unparseable key yields an empty string rather than 'NaN'", () => {
    expect(dayHeader("", "zh")).toBe("");
    expect(dayHeader("2026-13-99x", "en")).toBe("");
  });
});

describe("parseDayKey", () => {
  test("reads the date and its weekday without any time zone", () => {
    // 2026-09-24 is a Thursday wherever the code runs.
    expect(parseDayKey("2026-09-24")).toEqual({ year: 2026, month: 9, day: 24, weekday: 4 });
  });

  test("rejects anything that is not a real calendar date", () => {
    expect(parseDayKey("")).toBeNull();
    expect(parseDayKey("2026-9-24")).toBeNull();
    expect(parseDayKey("2026-02-30")).toBeNull();
    expect(parseDayKey("2026-13-01")).toBeNull();
  });
});

describe("weekdayLabel", () => {
  test("names the day from the language's table, Sunday first", () => {
    expect(weekdayLabel(0, "zh")).toBe("周日");
    expect(weekdayLabel(4, "zh-Hant")).toBe("週四");
    expect(weekdayLabel(6, "en")).toBe("Sat");
  });

  test("an index outside the week is an empty string, not 'undefined'", () => {
    expect(weekdayLabel(7, "zh")).toBe("");
    expect(weekdayLabel(-1, "en")).toBe("");
  });
});

describe("fillTemplate", () => {
  test("replaces every occurrence of each placeholder", () => {
    expect(fillTemplate("{{n}} / {{n}} · {{t}}", { n: 3, t: "x" })).toBe("3 / 3 · x");
  });
});

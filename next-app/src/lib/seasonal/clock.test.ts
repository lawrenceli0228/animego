import { describe, expect, test } from "bun:test";

import { READER_ZONE, SITE_ZONE, minuteOfWeek, siteDateKey, siteDayNumber, siteHhmm, siteTime, type ZoneOffset } from "./clock";

// The seasonal page reads every time on the Beijing clock, whatever zone the
// test runner (or the reader) is in. Each case is a UTC instant and what it
// is in Beijing.

describe("the Beijing clock", () => {
  test("a UTC afternoon is that evening in Beijing", () => {
    // Friday 2026-10-16 14:00 UTC → Friday 22:00 UTC+8.
    expect(siteTime(Date.UTC(2026, 9, 16, 14, 0))).toEqual({
      year: 2026,
      month: 10,
      day: 16,
      weekday: 5,
      hour: 22,
      minute: 0,
    });
    expect(siteHhmm(Date.UTC(2026, 9, 16, 14, 0))).toBe("22:00");
  });

  test("16:30 UTC is already tomorrow in Beijing — weekday and date both move", () => {
    const at = Date.UTC(2026, 9, 18, 16, 30); // Sunday UTC
    expect(siteTime(at).weekday).toBe(1); // Monday 00:30 in Beijing
    expect(siteDateKey(at)).toBe("2026-10-19");
    expect(siteHhmm(at)).toBe("00:30");
  });

  test("weekday runs 1 = Monday to 7 = Sunday", () => {
    // 2026-10-12 is a Monday.
    for (let i = 0; i < 7; i += 1) {
      expect(siteTime(Date.UTC(2026, 9, 12 + i, 4, 0)).weekday).toBe(i + 1);
    }
  });

  test("two instants share a day number exactly when they share a Beijing date", () => {
    const evening = Date.UTC(2026, 9, 16, 15, 59); // 23:59 Friday
    const midnight = Date.UTC(2026, 9, 16, 16, 0); // 00:00 Saturday
    expect(siteDayNumber(evening)).toBe(siteDayNumber(Date.UTC(2026, 9, 15, 16, 0)));
    expect(siteDayNumber(midnight)).toBe(siteDayNumber(evening) + 1);
  });

  test("minute of the week orders a timetable from Monday 00:00", () => {
    expect(minuteOfWeek(Date.UTC(2026, 9, 11, 16, 0))).toBe(0); // Monday 00:00
    expect(minuteOfWeek(Date.UTC(2026, 9, 18, 15, 59))).toBe(7 * 1440 - 1); // Sunday 23:59
    expect(minuteOfWeek(Date.UTC(2026, 9, 16, 14, 0))).toBe(4 * 1440 + 22 * 60); // Friday 22:00
  });
});

// After hydration the page reads the reader's own zone instead (see clock.ts).
// These zones are fixed offsets, so the tests do not depend on where they run.
const LOS_ANGELES: ZoneOffset = () => -7 * 60; // PDT in October
const SYDNEY: ZoneOffset = () => 11 * 60; // AEDT in October

describe("a reader's own clock", () => {
  test("Beijing's Monday 00:30 is Sunday morning in Los Angeles and Monday 03:30 in Sydney", () => {
    const at = Date.UTC(2026, 9, 18, 16, 30);
    expect(siteTime(at).weekday).toBe(1);
    expect(siteTime(at, LOS_ANGELES).weekday).toBe(7);
    expect(siteHhmm(at, LOS_ANGELES)).toBe("09:30");
    expect(siteDateKey(at, LOS_ANGELES)).toBe("2026-10-18");
    expect(siteTime(at, SYDNEY).weekday).toBe(1);
    expect(siteHhmm(at, SYDNEY)).toBe("03:30");
    expect(minuteOfWeek(at, LOS_ANGELES)).toBe(6 * 1440 + 9 * 60 + 30);
  });

  test("day numbers follow the reader's midnight, not Beijing's", () => {
    const beforeBeijingMidnight = Date.UTC(2026, 9, 16, 15, 0); // 23:00 Friday in Beijing, 02:00 Saturday in Sydney
    const now = Date.UTC(2026, 9, 16, 12, 0); // 20:00 Friday in Beijing, 23:00 Friday in Sydney
    expect(siteDayNumber(beforeBeijingMidnight)).toBe(siteDayNumber(now));
    expect(siteDayNumber(beforeBeijingMidnight, SYDNEY)).toBe(siteDayNumber(now, SYDNEY) + 1);
  });

  test("a zone with daylight saving reads each instant at its own offset", () => {
    // A zone that springs forward an hour at 02:00 local, as Sydney did on 2026-10-04.
    const change = Date.UTC(2026, 9, 3, 16, 0);
    const springing: ZoneOffset = (ms) => (ms < change ? 600 : 660);
    expect(siteHhmm(change - 60_000, springing)).toBe("01:59");
    expect(siteHhmm(change, springing)).toBe("03:00");
  });

  test("the site's zone is a fixed +8; the reader's is the runtime's own offset", () => {
    const ms = Date.UTC(2026, 9, 16, 12, 0);
    expect(SITE_ZONE(ms)).toBe(480);
    expect(READER_ZONE(ms)).toBe(-new Date(ms).getTimezoneOffset());
  });
});

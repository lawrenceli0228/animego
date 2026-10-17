import { describe, expect, test } from "bun:test";

import { minuteOfWeek, siteDateKey, siteDayNumber, siteHhmm, siteTime } from "./clock";

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

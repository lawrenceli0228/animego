import { describe, expect, test } from "bun:test";

import { NOW, item } from "@/lib/test-utils/seasonalItems";
import {
  BAR_EMPTY_PX,
  BAR_MAX_PX,
  BAR_MIN_PX,
  MAX_MONTH_BARS,
  WEEKDAY_MODE_MIN,
  barModeOf,
  monthBars,
  monthKeyOf,
  seasonBars,
  weekdayBars,
} from "./bars";
import { DEFAULT_STATE } from "./state";

/** An instant on Beijing `weekday` (1 = Monday) of the week of 2026-10-12, at 22:00. */
const onWeekday = (weekday: number) => Date.UTC(2026, 9, 11 + weekday, 14, 0);

describe("barModeOf", () => {
  const scheduled = (n: number) =>
    Array.from({ length: n }, (_, i) => item({ id: i + 1, next: { at: onWeekday(1), ep: 2 } }));

  test(`weekday mode needs ${WEEKDAY_MODE_MIN} scheduled shows`, () => {
    expect(barModeOf(scheduled(WEEKDAY_MODE_MIN - 1))).toBe("month");
    expect(barModeOf(scheduled(WEEKDAY_MODE_MIN))).toBe("weekday");
  });

  test("shows without a schedule do not count", () => {
    const mixed = [...scheduled(WEEKDAY_MODE_MIN - 1), ...Array.from({ length: 40 }, (_, i) => item({ id: 100 + i }))];
    expect(barModeOf(mixed)).toBe("month");
  });
});

describe("weekdayBars", () => {
  // Monday ×4, Wednesday ×2, Saturday ×1 — and one at 00:30 Saturday Beijing,
  // which is 16:30 Friday in UTC and must count as Saturday.
  const shows = [
    ...[1, 2, 3, 4].map((id) => item({ id, next: { at: onWeekday(1), ep: 2 } })),
    ...[5, 6].map((id) => item({ id, next: { at: onWeekday(3), ep: 2 } })),
    item({ id: 7, next: { at: Date.UTC(2026, 9, 16, 16, 30), ep: 2 } }),
    item({ id: 8 }),
  ];

  test("seven bars, Monday first, counted by the Beijing weekday", () => {
    const bars = weekdayBars(shows, DEFAULT_STATE, NOW);
    expect(bars.map((b) => b.weekday)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(bars.map((b) => b.count)).toEqual([4, 0, 2, 0, 0, 1, 0]);
  });

  test("heights scale against the busiest day; an empty day is a stub and cannot be pressed", () => {
    const bars = weekdayBars(shows, DEFAULT_STATE, NOW);
    expect(bars[0].heightPx).toBe(BAR_MAX_PX);
    expect(bars[2].heightPx).toBe(Math.round(BAR_MAX_PX / 2));
    expect(bars[5].heightPx).toBe(Math.max(BAR_MIN_PX, Math.round(BAR_MAX_PX / 4)));
    expect(bars[1]).toMatchObject({ heightPx: BAR_EMPTY_PX, disabled: true });
    expect(bars[0].disabled).toBe(false);
  });

  test("today is today in Beijing", () => {
    // NOW is Friday 20:00 in Beijing; 17:00 UTC the same instant-day is already Saturday there.
    expect(weekdayBars(shows, DEFAULT_STATE, NOW).filter((b) => b.today).map((b) => b.weekday)).toEqual([5]);
    const late = Date.UTC(2026, 9, 16, 17, 0);
    expect(weekdayBars(shows, DEFAULT_STATE, late).filter((b) => b.today).map((b) => b.weekday)).toEqual([6]);
  });

  test("the selected bar is the weekday filter", () => {
    const bars = weekdayBars(shows, { ...DEFAULT_STATE, wd: 3 }, NOW);
    expect(bars.filter((b) => b.selected).map((b) => b.weekday)).toEqual([3]);
  });

  test("the bars rise one after another", () => {
    expect(weekdayBars(shows, DEFAULT_STATE, NOW).map((b) => b.delayMs)).toEqual([0, 45, 90, 135, 180, 225, 270]);
  });
});

describe("monthBars", () => {
  test("one bar per premiere month, in order, 待定 last", () => {
    const shows = [
      item({ id: 1, start: "2026-11-03" }),
      item({ id: 2, start: "2026-10-02" }),
      item({ id: 3 }),
      item({ id: 4, start: "2026-10-20" }),
      item({ id: 5, start: "2025-12-24" }),
    ];
    const bars = monthBars(shows, DEFAULT_STATE);
    expect(bars.map((b) => [b.key, b.month, b.count])).toEqual([
      ["2025-12", 12, 1],
      ["2026-10", 10, 2],
      ["2026-11", 11, 1],
      ["tbd", null, 1],
    ]);
    expect(bars[1].heightPx).toBe(BAR_MAX_PX);
    expect(bars[0].heightPx).toBe(Math.round(BAR_MAX_PX / 2));
    expect(bars.map((b) => b.delayMs)).toEqual([0, 55, 110, 165]);
  });

  test(`at most ${MAX_MONTH_BARS} months, and 待定 is never the one dropped`, () => {
    const shows = [
      ...Array.from({ length: 9 }, (_, i) => item({ id: i + 1, start: `2026-${String(i + 1).padStart(2, "0")}-01` })),
      item({ id: 99 }),
    ];
    const keys = monthBars(shows, DEFAULT_STATE).map((b) => b.key);
    expect(keys).toEqual(["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "tbd"]);
  });

  test("the selected bar is the month filter", () => {
    const shows = [item({ id: 1, start: "2026-10-01" }), item({ id: 2 })];
    expect(monthBars(shows, { ...DEFAULT_STATE, mon: "tbd" }).map((b) => b.selected)).toEqual([false, true]);
  });

  test("monthKeyOf reads the premiere date", () => {
    expect(monthKeyOf(item({ id: 1, start: "2026-10-31" }))).toBe("2026-10");
    expect(monthKeyOf(item({ id: 2 }))).toBe("tbd");
  });
});

describe("seasonBars", () => {
  test("one bar is no chart", () => {
    expect(seasonBars([item({ id: 1 }), item({ id: 2 })], "month", DEFAULT_STATE, NOW)).toEqual([]);
  });

  test("weekday mode always draws the whole week", () => {
    const shows = Array.from({ length: 20 }, (_, i) => item({ id: i + 1, next: { at: onWeekday(2), ep: 3 } }));
    expect(seasonBars(shows, "weekday", DEFAULT_STATE, NOW)).toHaveLength(7);
  });
});

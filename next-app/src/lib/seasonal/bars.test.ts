import { describe, expect, test } from "bun:test";

import { NOW, item } from "@/lib/test-utils/seasonalItems";
import {
  BAR_EMPTY_PX,
  BAR_MAX_PX,
  BAR_MIN_PX,
  MAX_MONTH_BARS,
  WEEKDAY_MODE_MIN,
  airWeekday,
  barModeOf,
  hasWeeklySlot,
  monthBars,
  monthKeyOf,
  seasonBars,
  weekdayBars,
} from "./bars";
import { DEFAULT_STATE } from "./state";

/** An instant on Beijing `weekday` (1 = Monday) of the week of 2026-10-12, at 22:00. */
const onWeekday = (weekday: number) => Date.UTC(2026, 9, 11 + weekday, 14, 0);

describe("weekly slots", () => {
  test("only an airing show with an episode scheduled has one", () => {
    const at = onWeekday(2);
    expect(hasWeeklySlot(item({ id: 1, status: "RELEASING", next: { at, ep: 4 } }))).toBe(true);
    // An upcoming show's first episode is a premiere, read by the month chart.
    expect(hasWeeklySlot(item({ id: 2, status: "NOT_YET_RELEASED", next: { at, ep: 1 } }))).toBe(false);
    expect(hasWeeklySlot(item({ id: 3, status: "FINISHED", next: { at, ep: 13 } }))).toBe(false);
    expect(hasWeeklySlot(item({ id: 4, status: "RELEASING" }))).toBe(false);
  });

  test("a stale time in the past still names the weekday", () => {
    // Tuesday 22:00 a week before the clock's week: the row was not re-synced since.
    const stale = item({ id: 5, status: "RELEASING", next: { at: onWeekday(2) - 7 * 24 * 3_600_000, ep: 4 } });
    expect(airWeekday(stale)).toBe(2);
  });
});

describe("barModeOf", () => {
  const scheduled = (n: number) =>
    Array.from({ length: n }, (_, i) => item({ id: i + 1, next: { at: onWeekday(1), ep: 2 } }));

  test(`weekday mode needs ${WEEKDAY_MODE_MIN} scheduled shows`, () => {
    expect(barModeOf(scheduled(WEEKDAY_MODE_MIN - 1))).toBe("month");
    expect(barModeOf(scheduled(WEEKDAY_MODE_MIN))).toBe("weekday");
  });

  test("upcoming premieres do not make a season airing", () => {
    const upcoming = Array.from({ length: 30 }, (_, i) =>
      item({ id: 200 + i, status: "NOT_YET_RELEASED", next: { at: onWeekday(3), ep: 1 } }),
    );
    expect(barModeOf(upcoming)).toBe("month");
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

  test("only airing shows are counted: not an upcoming premiere, not a finished show's leftover", () => {
    const mixed = [
      ...shows,
      item({ id: 50, status: "NOT_YET_RELEASED", next: { at: onWeekday(2), ep: 1 } }),
      item({ id: 51, status: "FINISHED", next: { at: onWeekday(2), ep: 13 } }),
    ];
    expect(weekdayBars(mixed, DEFAULT_STATE, NOW)[1]).toMatchObject({ count: 0, disabled: true });
  });

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

describe("weekday bars on the reader's clock", () => {
  // Beijing's Monday 00:30 is Sunday 09:30 in Los Angeles (PDT, -7).
  const LOS_ANGELES = () => -7 * 60;
  const AUCKLAND = () => 13 * 60; // NZDT
  const lateNight = item({ id: 1, next: { at: Date.UTC(2026, 9, 18, 16, 30), ep: 3 } });

  test("a late-night show sits under the weekday it airs where the reader is", () => {
    expect(airWeekday(lateNight)).toBe(1);
    expect(airWeekday(lateNight, LOS_ANGELES)).toBe(7);
    const counts = weekdayBars([lateNight], DEFAULT_STATE, NOW, LOS_ANGELES).map((b) => b.count);
    expect(counts).toEqual([0, 0, 0, 0, 0, 0, 1]);
  });

  test("today is the reader's today", () => {
    // NOW is Friday 20:00 in Beijing and already Saturday 01:00 in Auckland.
    expect(weekdayBars([lateNight], DEFAULT_STATE, NOW).find((b) => b.today)?.weekday).toBe(5);
    expect(weekdayBars([lateNight], DEFAULT_STATE, NOW, AUCKLAND).find((b) => b.today)?.weekday).toBe(6);
    expect(seasonBars([lateNight, lateNight], "weekday", DEFAULT_STATE, NOW, AUCKLAND).find((b) => b.kind === "weekday" && b.today)).toBeTruthy();
  });
});

// The small bar chart beside the seasonal page's heading.
//
// Two modes, picked from the season's own data:
//
//   weekday  while the season is airing — at least WEEKDAY_MODE_MIN airing
//            shows have a next episode scheduled — seven bars, Monday to
//            Sunday, by the weekday that episode airs on the page's clock
//            (Beijing until hydration, the reader's zone after; see clock.ts).
//            Today's bar is marked.
//   month    otherwise (a past season, or one that has not started): one bar
//            per premiere month, plus 待定 for shows with no date.
//
// Counts are over the whole season, not the filtered list: the chart is a
// filter control, and a bar that shrinks to nothing under the other filters
// would be a control that hides itself.
//
// Pure: no React, no DOM.

import { SITE_ZONE, siteTime, type ZoneOffset } from "./clock";
import type { SeasonalItem } from "./model";
import { MONTH_TBD, type BrowseState } from "./state";

/** How many scheduled shows make a season "airing". */
export const WEEKDAY_MODE_MIN = 20;
/** The tallest bar, px. */
export const BAR_MAX_PX = 30;
/** The shortest bar that still has shows behind it, px. */
export const BAR_MIN_PX = 4;
/** An empty weekday still draws a stub. */
export const BAR_EMPTY_PX = 2;
/** Month bars beyond this many are left out (待定 is always kept). */
export const MAX_MONTH_BARS = 6;

export type BarMode = "weekday" | "month";

export interface WeekdayBar {
  kind: "weekday";
  /** 1 = Monday … 7 = Sunday. */
  weekday: number;
  count: number;
  heightPx: number;
  delayMs: number;
  selected: boolean;
  today: boolean;
  /** No show airs that day: nothing to filter to. */
  disabled: boolean;
}

export interface MonthBar {
  kind: "month";
  /** `YYYY-MM` or MONTH_TBD — the value of the `mon` filter. */
  key: string;
  /** 1–12; null for 待定. */
  month: number | null;
  count: number;
  heightPx: number;
  delayMs: number;
  selected: boolean;
}

export type Bar = WeekdayBar | MonthBar;

/**
 * A show with a weekly slot: airing, and with its next episode on the
 * schedule. An upcoming show's first episode is a premiere date, not a slot
 * in the week (the month chart reads it instead), and a finished show's
 * leftover schedule is no slot at all.
 *
 * The time itself may lie in the past — the API's next episode is only as
 * fresh as the row — and still names the weekday: a show keeps its slot.
 */
export function hasWeeklySlot(item: SeasonalItem): boolean {
  return item.status === "RELEASING" && item.next !== null;
}

/** Which chart the season gets. */
export function barModeOf(items: readonly SeasonalItem[]): BarMode {
  let slotted = 0;
  for (const item of items) if (hasWeeklySlot(item)) slotted += 1;
  return slotted >= WEEKDAY_MODE_MIN ? "weekday" : "month";
}

/** The weekday of a show's weekly slot on `zone`'s clock, 1–7, or 0 when it has none. */
export function airWeekday(item: SeasonalItem, zone: ZoneOffset = SITE_ZONE): number {
  return hasWeeklySlot(item) && item.next ? siteTime(item.next.at, zone).weekday : 0;
}

/** The premiere-month bucket a show falls in: `YYYY-MM`, or MONTH_TBD. */
export function monthKeyOf(item: SeasonalItem): string {
  return item.start ? item.start.slice(0, 7) : MONTH_TBD;
}

function scaled(count: number, max: number): number {
  return Math.max(BAR_MIN_PX, Math.round((BAR_MAX_PX * count) / Math.max(1, max)));
}

export function weekdayBars(
  items: readonly SeasonalItem[],
  state: BrowseState,
  nowMs: number,
  zone: ZoneOffset = SITE_ZONE,
): WeekdayBar[] {
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (const item of items) {
    const wd = airWeekday(item, zone);
    if (wd) counts[wd - 1] += 1;
  }
  const max = Math.max(1, ...counts);
  const today = siteTime(nowMs, zone).weekday;
  return counts.map((count, i) => ({
    kind: "weekday",
    weekday: i + 1,
    count,
    heightPx: count ? scaled(count, max) : BAR_EMPTY_PX,
    delayMs: i * 45,
    selected: state.wd === i + 1,
    today: today === i + 1,
    disabled: count === 0,
  }));
}

/** Chronological, 待定 last. */
function compareMonthKeys(a: string, b: string): number {
  if (a === b) return 0;
  if (a === MONTH_TBD) return 1;
  if (b === MONTH_TBD) return -1;
  return a < b ? -1 : 1;
}

export function monthBars(items: readonly SeasonalItem[], state: BrowseState): MonthBar[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = monthKeyOf(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const keys = [...counts.keys()].sort(compareMonthKeys);
  const months = keys.filter((k) => k !== MONTH_TBD).slice(0, MAX_MONTH_BARS);
  const shown = counts.has(MONTH_TBD) ? [...months, MONTH_TBD] : months;
  const max = Math.max(1, ...shown.map((k) => counts.get(k) ?? 0));
  return shown.map((key, i) => {
    const count = counts.get(key) ?? 0;
    return {
      kind: "month",
      key,
      month: key === MONTH_TBD ? null : Number(key.slice(5, 7)),
      count,
      heightPx: scaled(count, max),
      delayMs: i * 55,
      selected: state.mon === key,
    };
  });
}

/** The chart for this season; fewer than two bars is no chart at all (nothing to compare). */
export function seasonBars(
  items: readonly SeasonalItem[],
  mode: BarMode,
  state: BrowseState,
  nowMs: number,
  zone: ZoneOffset = SITE_ZONE,
): Bar[] {
  const bars: Bar[] = mode === "weekday" ? weekdayBars(items, state, nowMs, zone) : monthBars(items, state);
  return bars.length > 1 ? bars : [];
}

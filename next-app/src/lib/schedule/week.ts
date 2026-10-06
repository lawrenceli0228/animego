// The schedule page's week: seven `YYYY-MM-DD` keys starting from the API's
// "today", the labels for them, and the two numbers each day contributes to
// the page — whose colour it wears and how tall its bar is.
//
// Date arithmetic on day keys only: no clock and no time zone, so the server
// render and every browser agree on what the tabs say.
//
// Pure: no React, no DOM.

import type { Lang } from "@/lib/i18n/lang";
import { parseDayKey } from "@/lib/home/time";

/** /api/anime/schedule's window, and the number of tabs. */
export const WEEK_DAYS = 7;

/** The busiest day's bar, in px. The others scale against it. */
export const BAR_MAX_PX = 96;
/** A quiet (or empty) day still draws a stub you can see and click. */
export const BAR_MIN_PX = 8;

const pad2 = (n: number) => String(n).padStart(2, "0");

/** `dayKey` moved by `n` days; empty when `dayKey` is not a real date. */
export function addDays(dayKey: string, n: number): string {
  const parts = parseDayKey(dayKey);
  if (!parts) return "";
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + n));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * The seven days the page has tabs for, today first.
 *
 * Built from the date rather than from the API's group keys: a day with
 * nothing airing has no group at all, and it still gets a tab (with a 0).
 */
export function weekKeys(todayKey: string): string[] {
  if (!parseDayKey(todayKey)) return [];
  return Array.from({ length: WEEK_DAYS }, (_, i) => addDays(todayKey, i));
}

/** "9/24" — the date line under a weekday tab. */
export function monthDay(dayKey: string): string {
  const parts = parseDayKey(dayKey);
  return parts ? `${parts.month}/${parts.day}` : "";
}

const WEEKDAY_SHORT: Record<Lang, readonly string[]> = {
  zh: ["日", "一", "二", "三", "四", "五", "六"],
  en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  // The seven characters are the same in Traditional.
  "zh-Hant": ["日", "一", "二", "三", "四", "五", "六"],
};

/** The bar chart's axis label: "四", "Thu". Empty outside the week. */
export function weekdayShort(weekday: number, lang: Lang): string {
  return WEEKDAY_SHORT[lang][weekday] ?? "";
}

/**
 * The show whose colour a day wears: the best-rated one, the earlier airing on
 * a tie, the first airing when nobody is rated. Null for an empty day.
 *
 * Expects airing order, which is how the API groups arrive.
 */
export function leadOf<T extends { averageScore?: number | null }>(rows: readonly T[]): T | null {
  let lead: T | null = null;
  for (const row of rows) {
    if (lead === null) {
      lead = row;
      continue;
    }
    if ((row.averageScore ?? 0) > (lead.averageScore ?? 0)) lead = row;
  }
  return lead;
}

/** A day's bar height in px, against the week's busiest day. */
export function barHeight(count: number, max: number): number {
  if (max <= 0 || count <= 0) return BAR_MIN_PX;
  return Math.max(BAR_MIN_PX, Math.round((BAR_MAX_PX * count) / max));
}

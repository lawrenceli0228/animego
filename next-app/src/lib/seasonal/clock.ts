// The seasonal page's calendar: Beijing wall-clock time, always.
//
// Weekday bars, "今天 / 明天" badges, air times and premiere months are all
// read on the site's own clock (UTC+8, the zone /api/anime/schedule and the
// rest of the schedule UI are anchored to). The browser's zone is never
// consulted, so the server render, hydration and every reader agree on which
// weekday a show belongs to.
//
// Plain offset arithmetic instead of Intl: Node and the browser ship different
// ICU data, and nothing here may render differently on the two sides.
// China keeps no daylight saving, so a fixed offset is exact.
//
// Pure: no React, no DOM.

import { SITE_UTC_OFFSET_MIN } from "@/lib/schedule/zone";

export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;
const OFFSET_MS = SITE_UTC_OFFSET_MIN * 60_000;

export interface SiteTime {
  year: number;
  /** 1–12. */
  month: number;
  day: number;
  /** 1 = Monday … 7 = Sunday. */
  weekday: number;
  hour: number;
  minute: number;
}

/** Calendar fields of an instant on the Beijing clock. */
export function siteTime(ms: number): SiteTime {
  const d = new Date(ms + OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: ((d.getUTCDay() + 6) % 7) + 1,
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

/** Whole days since the epoch on the Beijing calendar: two instants share a value iff they share a date there. */
export function siteDayNumber(ms: number): number {
  return Math.floor((ms + OFFSET_MS) / DAY_MS);
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** "22:00" on the Beijing clock. */
export function siteHhmm(ms: number): string {
  const t = siteTime(ms);
  return `${pad2(t.hour)}:${pad2(t.minute)}`;
}

/** `YYYY-MM-DD` on the Beijing clock. */
export function siteDateKey(ms: number): string {
  const t = siteTime(ms);
  return `${t.year}-${pad2(t.month)}-${pad2(t.day)}`;
}

/** Minutes since Monday 00:00 on the Beijing clock: the order of a week's timetable. */
export function minuteOfWeek(ms: number): number {
  const t = siteTime(ms);
  return (t.weekday - 1) * 1440 + t.hour * 60 + t.minute;
}

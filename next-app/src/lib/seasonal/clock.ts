// The seasonal page's calendar: which weekday, date and wall-clock time an
// instant is.
//
// Weekday bars, "今天 / 明天" badges, air times and premiere months are read on
// one clock per render. The server and hydration read the site's own clock
// (UTC+8, the zone /api/anime/schedule and the rest of the schedule UI are
// anchored to), so the first paint and hydration agree; after hydration the
// page reads the reader's own zone, the way the home page's 今日更新 and
// /calendar do — "今天 22:00" is the reader's today, and a late-night show
// sits under the weekday it airs where they are. A reader on UTC+8 sees no
// change. Every function takes that clock as `zone`; the default is the site's.
//
// Plain offset arithmetic instead of Intl: Node and the browser ship different
// ICU data, and nothing here may render differently on the two sides.
//
// Pure: no React, no DOM.

import { SITE_UTC_OFFSET_MIN } from "@/lib/schedule/zone";

export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;

/**
 * A clock, as its offset from UTC in minutes (east positive) at an instant —
 * a function of the instant, because a zone with daylight saving has a
 * different offset either side of its change.
 */
export type ZoneOffset = (ms: number) => number;

/** The site's clock: Asia/Shanghai, a fixed +8 (China keeps no daylight saving). */
export const SITE_ZONE: ZoneOffset = () => SITE_UTC_OFFSET_MIN;

/** The runtime's own zone — the reader's, in a browser. Read it only after hydration. */
export const READER_ZONE: ZoneOffset = (ms) => -new Date(ms).getTimezoneOffset();

const shifted = (ms: number, zone: ZoneOffset) => ms + zone(ms) * 60_000;

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

/** Calendar fields of an instant on `zone`'s clock. */
export function siteTime(ms: number, zone: ZoneOffset = SITE_ZONE): SiteTime {
  const d = new Date(shifted(ms, zone));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: ((d.getUTCDay() + 6) % 7) + 1,
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

/** Whole days since the epoch on `zone`'s calendar: two instants share a value iff they share a date there. */
export function siteDayNumber(ms: number, zone: ZoneOffset = SITE_ZONE): number {
  return Math.floor(shifted(ms, zone) / DAY_MS);
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** "22:00" on `zone`'s clock. */
export function siteHhmm(ms: number, zone: ZoneOffset = SITE_ZONE): string {
  const t = siteTime(ms, zone);
  return `${pad2(t.hour)}:${pad2(t.minute)}`;
}

/** `YYYY-MM-DD` on `zone`'s clock. */
export function siteDateKey(ms: number, zone: ZoneOffset = SITE_ZONE): string {
  const t = siteTime(ms, zone);
  return `${t.year}-${pad2(t.month)}-${pad2(t.day)}`;
}

/** Minutes since Monday 00:00 on `zone`'s clock: the order of a week's timetable. */
export function minuteOfWeek(ms: number, zone: ZoneOffset = SITE_ZONE): number {
  const t = siteTime(ms, zone);
  return (t.weekday - 1) * 1440 + t.hour * 60 + t.minute;
}

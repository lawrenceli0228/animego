// Clock and calendar strings for the homepage and the schedule page.
//
// These run inside client components during hydration, so the server (Node's
// ICU) and the browser (its own ICU) must produce byte-identical output. They
// do not agree on localised date strings — Node formats zh-CN weekday+time as
// "周日19:00", Bun and Chrome as "周日 19:00" — so Intl is only asked for
// numeric parts, in en-US, and the words come from the tables below — keyed
// by Lang, so a new language is a compile error here, not a silent
// fallthrough.
//
// Pure: no DOM, no React.

import type { Lang } from "@/lib/i18n/lang";

/**
 * The site's own zone: what /api/anime/schedule's day groups and the rest of
 * the schedule UI are anchored to. Client components render in it on the
 * server and during hydration, then switch to the browser's zone.
 */
export const SITE_TZ = "Asia/Shanghai";

export interface ClockParts {
  /** Wall-clock date in the zone, `YYYY-MM-DD`. */
  dayKey: string;
  /** 0 = Sunday. */
  weekday: number;
  /** 00–23. */
  hh: string;
  /** 00–59. */
  mm: string;
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const formatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? "";
  let fmt = formatters.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    formatters.set(key, fmt);
  }
  return fmt;
}

/** `timeZone` undefined means the runtime's own zone (the browser's, on the client). */
export function clockParts(ms: number, timeZone: string | undefined): ClockParts {
  const parts: Record<string, string> = {};
  for (const p of partsFormatter(timeZone).formatToParts(new Date(ms))) parts[p.type] = p.value;
  // Some engines still emit "24" for midnight even under h23.
  const hh = parts.hour === "24" ? "00" : parts.hour;
  return {
    dayKey: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: WEEKDAY_INDEX[parts.weekday] ?? 0,
    hh,
    mm: parts.minute,
  };
}

export function hhmm(ms: number, timeZone: string | undefined): string {
  const { hh, mm } = clockParts(ms, timeZone);
  return `${hh}:${mm}`;
}

const WEEKDAY_LABELS: Record<Lang, readonly string[]> = {
  zh: ["周日", "周一", "周二", "周三", "周四", "周五", "周六"],
  en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  // 週, not 周: both exist in Traditional, and 週 is what Taiwan and Hong Kong
  // write for a day of the week.
  "zh-Hant": ["週日", "週一", "週二", "週三", "週四", "週五", "週六"],
};

/** "周四" for weekday 4 (0 = Sunday); empty for an index outside the week. */
export function weekdayLabel(weekday: number, lang: Lang): string {
  return WEEKDAY_LABELS[lang][weekday] ?? "";
}

/** "周日 19:00" — when the next episode of a show goes out. */
export function weekdayTime(ms: number, timeZone: string | undefined, lang: Lang): string {
  const { weekday, hh, mm } = clockParts(ms, timeZone);
  return `${weekdayLabel(weekday, lang)} ${hh}:${mm}`;
}

const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const DAY_HEADER: Record<Lang, (weekday: string, month: number, day: number) => string> = {
  zh: (w, m, d) => `${w} ${m}月${d}日`,
  en: (w, m, d) => `${w}, ${EN_MONTHS[m - 1]} ${d}`,
  "zh-Hant": (w, m, d) => `${w} ${m}月${d}日`,
};

export interface DayKeyParts {
  year: number;
  /** 1–12. */
  month: number;
  day: number;
  /** 0 = Sunday. */
  weekday: number;
}

/**
 * A `YYYY-MM-DD` day key as numbers, or null when it is not a real date.
 *
 * The key is already a calendar date, so no zone is involved: the weekday is
 * computed from the date itself, and comes out the same on every runtime.
 */
export function parseDayKey(dayKey: string): DayKeyParts | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { year, month, day, weekday: date.getUTCDay() };
}

/**
 * "周四 9月24日" for a `YYYY-MM-DD` day key. Empty for anything that is not a
 * real date.
 */
export function dayHeader(dayKey: string, lang: Lang): string {
  const parts = parseDayKey(dayKey);
  if (!parts) return "";
  return DAY_HEADER[lang](weekdayLabel(parts.weekday, lang), parts.month, parts.day);
}

/** `{{name}}` substitution — the same contract as lib/i18n's `fill`, without its dictionary imports. */
export function fillTemplate(template: string, values: Record<string, string | number>): string {
  let out = template;
  for (const [key, value] of Object.entries(values)) {
    out = out.split(`{{${key}}}`).join(String(value));
  }
  return out;
}

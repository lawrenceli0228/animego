// Which years have a ranking, and which of them the switch strip offers.
//
// The years come from /api/anime/top/years: every release year with at least
// one ranked show, and how many. They decide four things: the strip (every
// year), the 更早 menu (the years before the strip's), whether /top/{year} is a
// page at all (a year with nothing ranked is a 404, never an empty list), and
// the sitemap.
//
// Pure: no React, no DOM.

import { parseHubYear } from "@/lib/hubs/paths";

export interface TopYear {
  year: number;
  /** How many shows the year ranks from (its page lists at most a hundred). */
  count: number;
}

/** The strip's years: the current one and the twelve before it. */
export const STRIP_YEARS = 13;

/** The site's clock: China's, at +08:00 all year (the genre page's "recent" turns over on it too). */
const SITE_OFFSET_MS = 8 * 60 * 60 * 1000;

/** The year it is on the site's clock at `nowMs`. */
export function siteYear(nowMs: number): number {
  return new Date(nowMs + SITE_OFFSET_MS).getUTCFullYear();
}

/** The years out of the API's answer: valid ones only, each once, newest first. Never throws. */
export function parseTopYears(data: unknown): TopYear[] {
  if (!Array.isArray(data)) return [];
  const byYear = new Map<number, number>();
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const { year, count } = entry as { year?: unknown; count?: unknown };
    if (typeof year !== "number" || !Number.isInteger(year) || byYear.has(year)) continue;
    if (typeof count !== "number" || !Number.isFinite(count) || count < 1) continue;
    byYear.set(year, Math.floor(count));
  }
  return [...byYear.entries()].map(([year, count]) => ({ year, count })).sort((a, b) => b.year - a.year);
}

/** Whether `year` has a ranking — and so a page. */
export function isRankedYear(years: readonly TopYear[], year: number): boolean {
  return years.some((y) => y.year === year);
}

export interface StripYears {
  /** The strip's own cells, newest first. */
  recent: number[];
  /** The 更早 menu, newest first. */
  older: number[];
}

/**
 * The strip of `nowYear`: the years of the last STRIP_YEARS that have a
 * ranking, and every ranked year before them for the 更早 menu. Without an
 * answer from the API (`years` null) the strip still offers the last
 * STRIP_YEARS years, so the page is never without a way to another year.
 */
export function stripYears(years: readonly TopYear[] | null, nowYear: number): StripYears {
  const first = nowYear - STRIP_YEARS + 1;
  if (years === null) {
    return { recent: Array.from({ length: STRIP_YEARS }, (_, i) => nowYear - i), older: [] };
  }
  const ranked = years.map((y) => y.year);
  return {
    recent: ranked.filter((y) => y >= first && y <= nowYear),
    older: ranked.filter((y) => y < first),
  };
}

/** A /top/[year] segment as a year: four digits in the hub range; null otherwise. */
export function parseTopYear(raw: string): number | null {
  return parseHubYear(raw);
}

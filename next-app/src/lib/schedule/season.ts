// Seasons as the schedule page needs them: this one (the eyebrow over the
// title) and the next one (the "2027 冬季新番" link at the bottom of the
// aside), with its route and its first month.
//
// Quarter boundaries match every other getCurrentSeason() copy in the app
// (Jan–Mar winter, Apr–Jun spring, Jul–Sep summer, Oct–Dec fall).
//
// Pure: no React, no DOM.

import type { Lang } from "@/lib/i18n/lang";

export type SeasonKey = "WINTER" | "SPRING" | "SUMMER" | "FALL";

export interface SeasonYear {
  season: SeasonKey;
  year: number;
}

const ORDER: readonly SeasonKey[] = ["WINTER", "SPRING", "SUMMER", "FALL"];

/** The season `date` falls in, by its (runtime-local) month. */
export function seasonOf(date: Date): SeasonYear {
  return { season: ORDER[Math.floor(date.getMonth() / 3)], year: date.getFullYear() };
}

export function nextSeasonOf({ season, year }: SeasonYear): SeasonYear {
  const i = ORDER.indexOf(season);
  return i === ORDER.length - 1 ? { season: ORDER[0], year: year + 1 } : { season: ORDER[i + 1], year };
}

/** `/seasonal/winter/2027` — the seasonal route takes the lower-case slug. */
export function seasonHref({ season, year }: SeasonYear): string {
  return `/seasonal/${season.toLowerCase()}/${year}`;
}

const EN_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const MONTH_LABEL: Record<Lang, (month: number) => string> = {
  zh: (m) => `${m} 月`,
  en: (m) => EN_MONTHS[m - 1],
  "zh-Hant": (m) => `${m} 月`,
};

/** "10 月" / "October" — when a season's shows start airing. */
export function startMonthLabel(season: SeasonKey, lang: Lang): string {
  return MONTH_LABEL[lang](ORDER.indexOf(season) * 3 + 1);
}

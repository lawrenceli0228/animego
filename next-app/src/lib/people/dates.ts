// Birthdays and other profile dates.
//
// AniList keeps them part by part, and a birthday is most often a month and a
// day with no year — exactly the case the site's formatFuzzyDate declines
// (it needs a year). Dates with a year render the way the rest of the site
// renders a date (formatFuzzyDate: 1994年6月4日 / 1994-06-04); dates without
// one render as a month and a day.

import { formatFuzzyDate, type FuzzyDate } from "@/lib/formatters";
import type { Lang } from "@/lib/i18n/lang";

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

const MONTH_DAY: Record<Lang, (month: number, day: number | null) => string> = {
  zh: (m, d) => `${m}月${d ? `${d}日` : ""}`,
  en: (m, d) => (d ? `${EN_MONTHS[m - 1]} ${d}` : EN_MONTHS[m - 1]),
  "zh-Hant": (m, d) => `${m}月${d ? `${d}日` : ""}`,
};

/** A profile date for the page; null when AniList knows no part of it. */
export function formatProfileDate(date: FuzzyDate | null | undefined, lang: Lang): string | null {
  if (!date) return null;
  if (date.year) return formatFuzzyDate(date, lang);
  if (date.month && date.month >= 1 && date.month <= 12) return MONTH_DAY[lang](date.month, date.day);
  return null;
}

/**
 * An ISO-8601 date for schema.org (YYYY, YYYY-MM or YYYY-MM-DD), or null.
 * A month and day with no year is valid ISO (--06-04) but not a birthDate
 * Google reads, so it is left out rather than sent.
 */
export function isoProfileDate(date: FuzzyDate | null | undefined): string | null {
  if (!date?.year) return null;
  return formatFuzzyDate(date, "en");
}

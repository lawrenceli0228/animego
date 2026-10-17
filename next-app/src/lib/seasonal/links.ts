// Links to other seasons — the page's year and season pickers.
//
// They are real <a href>s in the server HTML, menus included, because they are
// the season link graph a crawler walks: every year of this season and every
// season of this year, from every season page. The year range is the one the
// old season nav offered (2000 to next year), so that graph is unchanged.
//
// Pure: no React, no DOM.

import { stateForOtherSeason } from "./browse";
import { browseSearch, type BrowseState } from "./state";

export type SeasonSlug = "winter" | "spring" | "summer" | "fall";

/** In calendar order. */
export const SEASON_SLUGS: readonly SeasonSlug[] = ["winter", "spring", "summer", "fall"];

/** The first year the pickers offer. */
export const YEAR_MIN = 2000;

/** The AniList enum for a slug: "fall" → "FALL". */
export function seasonEnum(slug: SeasonSlug): "WINTER" | "SPRING" | "SUMMER" | "FALL" {
  return slug.toUpperCase() as "WINTER" | "SPRING" | "SUMMER" | "FALL";
}

/**
 * Newest first: next year down to 2000, plus the year on screen when it lies
 * outside that range (the route accepts 1990–2100), so the picker can always
 * show which year it is on.
 */
export function yearOptions(currentYear: number, clockYear: number): number[] {
  const years: number[] = [];
  for (let y = clockYear + 1; y >= YEAR_MIN; y -= 1) years.push(y);
  if (!years.includes(currentYear)) {
    years.push(currentYear);
    years.sort((a, b) => b - a);
  }
  return years;
}

/**
 * The route for a season, carrying the filters that still mean something
 * there (see stateForOtherSeason). Locale-free: LocaleLink adds the prefix.
 */
export function seasonHref(season: SeasonSlug, year: number, state: BrowseState): string {
  return `/seasonal/${season}/${year}${browseSearch(stateForOtherSeason(state))}`;
}

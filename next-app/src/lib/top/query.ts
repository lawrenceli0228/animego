// What a top-100 page shows, and how that is written in its URL.
//
//   /top                    the hundred best-rated shows of every year
//   /top/2025               the hundred best of one release year
//   ?format=movie           tv | movie | ona | ova | special
//   ?genre=slice-of-life    one browsable genre, by its slug
//   ?season=fall            winter | spring | summer | fall — a year's page only
//   ?view=chart             how the cards are drawn: grid (default) | chart | table
//
// A filter takes the hundred best of what it leaves, numbered afresh (the API
// does the ranking). The query is read leniently, as the genre page reads its
// own: a value that is not one of the options is no filter at all, so a
// mistyped link lands on the unfiltered list rather than on an error. Every
// lookup goes through a Map, so a name like `constructor` or `__proto__` is no
// option either.
//
// The canonical address writes the filters in one order and leaves the view
// out: a view is the same hundred drawn another way, not another list.
//
// Pure: no React, no DOM.

import { FILTER_GENRES, type FilterGenre } from "@/lib/contentLabels";
import type { QuerySource } from "@/lib/genre/views";
import { genreFromSlug, genreSlug, topPath } from "@/lib/hubs/paths";
import { VIEW_KEYS, type ViewKey } from "@/lib/seasonal/state";

/** The format chips, in the order they are shown. */
export const TOP_FORMATS = ["TV", "MOVIE", "ONA", "OVA", "SPECIAL"] as const;
export type TopFormat = (typeof TOP_FORMATS)[number];

/** The season chips of a year's page, in the order of the year. */
export const TOP_SEASONS = ["WINTER", "SPRING", "SUMMER", "FALL"] as const;
export type TopSeason = (typeof TOP_SEASONS)[number];

/** The genres a ranking can be narrowed to: the browsable ones, as everywhere. */
export const TOP_GENRES: readonly FilterGenre[] = FILTER_GENRES;

export interface TopFilters {
  format: TopFormat | null;
  genre: FilterGenre | null;
  /** Only ever set on a year's page. */
  season: TopSeason | null;
}

/** One ranking, as a page shows it. */
export interface TopState extends TopFilters {
  /** The release year, or null for every year. */
  year: number | null;
  view: ViewKey;
}

export const NO_FILTERS: TopFilters = { format: null, genre: null, season: null };

const FORMAT_BY_SLUG: ReadonlyMap<string, TopFormat> = new Map(TOP_FORMATS.map((f) => [f.toLowerCase(), f]));
const SEASON_BY_SLUG: ReadonlyMap<string, TopSeason> = new Map(TOP_SEASONS.map((s) => [s.toLowerCase(), s]));
const VIEW_BY_KEY: ReadonlyMap<string, ViewKey> = new Map(VIEW_KEYS.map((v) => [v, v]));

const slugOf = (raw: string | null): string => (raw ?? "").trim().toLowerCase();

/** The ranking `query` asks for on the page of `year` (null: every year). Never throws. */
export function parseTopState(query: QuerySource, year: number | null): TopState {
  return {
    year,
    format: FORMAT_BY_SLUG.get(slugOf(query.get("format"))) ?? null,
    genre: genreFromSlug(slugOf(query.get("genre"))),
    season: year === null ? null : (SEASON_BY_SLUG.get(slugOf(query.get("season"))) ?? null),
    view: VIEW_BY_KEY.get(slugOf(query.get("view"))) ?? "grid",
  };
}

/** Whether any filter narrows the ranking (the view is no filter). */
export function hasFilters(state: TopFilters): boolean {
  return state.format !== null || state.genre !== null || state.season !== null;
}

/** The query string (with its `?`), filters in their one order; "" for none. */
function searchOf(state: TopState, withView: boolean): string {
  const params = new URLSearchParams();
  if (state.format) params.set("format", state.format.toLowerCase());
  if (state.genre) params.set("genre", genreSlug(state.genre));
  if (state.year !== null && state.season) params.set("season", state.season.toLowerCase());
  if (withView && state.view !== "grid") params.set("view", state.view);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** `state`'s query string as a link writes it (the view included), with its `?`; "" for none. */
export function topSearch(state: TopState): string {
  return searchOf(state, true);
}

/**
 * Where a link to `state` goes: the view included, so a reader's chosen view
 * carries over to the next ranking. Locale-free, like every href in the tree.
 */
export function topHref(state: TopState): string {
  return `${topPath(state.year)}${searchOf(state, true)}`;
}

/** The page's canonical address: its filters in their one order, no view. */
export function topCanonical(state: TopState): string {
  return `${topPath(state.year)}${searchOf(state, false)}`;
}

/** The API request for `state`'s ranking, parameters in one order (one cache entry per ranking). */
export function topApiPath(state: TopFilters & { year: number | null }): string {
  const params = new URLSearchParams();
  if (state.year !== null) params.set("year", String(state.year));
  if (state.format) params.set("format", state.format);
  if (state.year !== null && state.season) params.set("season", state.season);
  if (state.genre) params.set("genre", state.genre);
  const qs = params.toString();
  return qs ? `/api/anime/top?${qs}` : "/api/anime/top";
}

/** `state` moved to another ranking: the season goes with the year it belonged to. */
export function withYear(state: TopState, year: number | null): TopState {
  return { ...state, year, season: year !== null && year === state.year ? state.season : null };
}

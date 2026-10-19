// What a genre page shows, and how that is written in its URL.
//
// One route, two views:
//
//   /genre/action                 the hub: rails, the top ten and the tiles
//   /genre/action?list=airing     a grid of every title in one slice of it
//   /genre/action?decade=1990
//   /genre/action?with=fantasy    titles carrying both genres
//
//   list    airing | popular | recent | classic | top
//   decade  2020 | 2010 | 2000 | 1990 | 1980 | 1970 | old (1969 and earlier)
//   with    another browsable genre's slug
//   page    1–200, 36 titles to a page
//
// When several are present the first valid one in that order wins (list, then
// decade, then with); anything unknown is ignored, so a mistyped link lands on
// the hub rather than on an error. The page before this one was a paginated
// popularity list at ?page=N, and search engines have those URLs: a page
// number with no view is that list, and the page sends it on, for good, to the
// popularity grid's page that holds the old page's first title.
//
// Each view has one address (viewPath) — its canonical. A grid is a page of
// its own, not a copy of the hub: 1990s action, action with fantasy, the top
// rated, each with its own heading and titles.
//
// Pure: no React, no DOM.

import { FILTER_GENRES, type FilterGenre } from "@/lib/contentLabels";
import { genreFromSlug, genrePath, genreSlug } from "@/lib/hubs/paths";

export const LIST_KEYS = ["airing", "popular", "recent", "classic", "top"] as const;
export type ListKey = (typeof LIST_KEYS)[number];

/** The hub's rails, in the order they are shown. The top ten has its own column. */
export const RAIL_KEYS = ["airing", "popular", "recent", "classic"] as const satisfies readonly ListKey[];
export type RailKey = (typeof RAIL_KEYS)[number];

/** Newest first, as the tiles are shown. `old` is 1969 and earlier. */
export const DECADE_KEYS = ["2020", "2010", "2000", "1990", "1980", "1970", "old"] as const;
export type DecadeKey = (typeof DECADE_KEYS)[number];

/** Titles to a grid page — six rows of six on a desktop. */
export const GRID_PAGE_SIZE = 36;

/** The API's own ceiling on `page`; nobody reads page 201 of a genre. */
export const MAX_GRID_PAGE = 200;

/**
 * Titles to a page of the list this page replaced (?page=N). Its pages were
 * shorter than the grid's, so the old page N is not the grid's page N.
 */
export const LEGACY_PAGE_SIZE = 24;

export type GridView =
  | { kind: "list"; list: ListKey }
  | { kind: "decade"; decade: DecadeKey }
  | { kind: "with"; with: FilterGenre };

export type GenreView =
  | { kind: "hub" }
  | {
      kind: "grid";
      view: GridView;
      page: number;
      /** Arrived by the old paginated URL (?page=N and nothing else). */
      legacy: boolean;
    };

/** Anything with URLSearchParams' `get` — the server's query record or the router's query. */
export interface QuerySource {
  get(name: string): string | null;
}

/** A Next `searchParams` record as a QuerySource: a repeated key reads as its first value. */
export function queryFromRecord(record: Record<string, string | string[] | undefined>): QuerySource {
  return {
    get(name) {
      if (!Object.prototype.hasOwnProperty.call(record, name)) return null;
      const v = record[name];
      if (Array.isArray(v)) return v[0] ?? null;
      return v ?? null;
    },
  };
}

function isListKey(v: string): v is ListKey {
  return (LIST_KEYS as readonly string[]).includes(v);
}

export function isDecadeKey(v: string): v is DecadeKey {
  return (DECADE_KEYS as readonly string[]).includes(v);
}

/** `page` as a page number: digits only, at least 1, at most MAX_GRID_PAGE; null when it is not one. */
export function parseGridPage(raw: string | null): number | null {
  if (raw === null || !/^\d{1,6}$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  if (n < 1) return null;
  return Math.min(n, MAX_GRID_PAGE);
}

/** The view `query` asks for on `genre`'s page. Never throws; anything it cannot read is the hub. */
export function parseGenreView(query: QuerySource, genre: FilterGenre): GenreView {
  const list = query.get("list")?.trim() ?? "";
  const decade = query.get("decade")?.trim() ?? "";
  const withSlug = query.get("with")?.trim().toLowerCase() ?? "";
  const page = parseGridPage(query.get("page"));

  let view: GridView | null = null;
  if (isListKey(list)) {
    view = { kind: "list", list };
  } else if (isDecadeKey(decade)) {
    view = { kind: "decade", decade };
  } else if (withSlug) {
    const other = genreFromSlug(withSlug);
    if (other && other !== genre) view = { kind: "with", with: other };
  }

  if (view) return { kind: "grid", view, page: page ?? 1, legacy: false };
  if (page !== null) return { kind: "grid", view: { kind: "list", list: "popular" }, page, legacy: true };
  return { kind: "hub" };
}

/** The query string (with its `?`) a grid view is written as; "" for nothing. */
export function gridSearch(view: GridView, page = 1): string {
  const params = new URLSearchParams();
  if (view.kind === "list") params.set("list", view.list);
  else if (view.kind === "decade") params.set("decade", view.decade);
  else params.set("with", genreSlug(view.with));
  if (page > 1) params.set("page", String(Math.min(Math.floor(page), MAX_GRID_PAGE)));
  return `?${params.toString()}`;
}

/** A grid view's page. Locale-free, like every href in the tree: LocaleLink adds the prefix. */
export function gridHref(genre: FilterGenre, view: GridView, page = 1): string {
  return `${genrePath(genre)}${gridSearch(view, page)}`;
}

/** The grid page that holds the first title of the old list's page `n`. */
export function legacyGridPage(n: number): number {
  return Math.min(Math.floor(((n - 1) * LEGACY_PAGE_SIZE) / GRID_PAGE_SIZE) + 1, MAX_GRID_PAGE);
}

/**
 * The one address of `view`, locale-free: its canonical, and where the old
 * ?page=N is sent. The hub is the genre's path; a grid is its view and page
 * as gridSearch writes them, so every other spelling of it — ?page=1,
 * parameters repeated or unknown, a view that lost to another — names this.
 * A pairing is the same titles from either side (action with fantasy is
 * fantasy with action), so it is written from the genre the strip lists
 * first; the other side still opens, and points here.
 */
export function viewPath(genre: FilterGenre, view: GenreView): string {
  if (view.kind === "hub") return genrePath(genre);
  const page = view.legacy ? legacyGridPage(view.page) : view.page;
  if (view.view.kind === "with" && FILTER_GENRES.indexOf(view.view.with) < FILTER_GENRES.indexOf(genre)) {
    return gridHref(view.view.with, { kind: "with", with: genre }, page);
  }
  return gridHref(genre, view.view, page);
}

/** The genres the hub's strip offers: every browsable one, in the site's order. */
export const STRIP_GENRES: readonly FilterGenre[] = FILTER_GENRES;

/** Two grid views are the same slice. */
export function sameGridView(a: GridView, b: GridView): boolean {
  if (a.kind === "list" && b.kind === "list") return a.list === b.list;
  if (a.kind === "decade" && b.kind === "decade") return a.decade === b.decade;
  if (a.kind === "with" && b.kind === "with") return a.with === b.with;
  return false;
}

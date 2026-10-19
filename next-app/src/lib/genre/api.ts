// A grid view as the /api/anime/browse request that lists it.
//
// The hub's rails come from /api/anime/genre-overview, and each rail's
// "see all" opens the grid on the same slice. The two endpoints share their
// filters, their order and their counts, so the grid opens on the rail's first
// six — as long as the slice is described the same way on both sides (the
// table at the top of go-api's genre_overview.go). The two year rules that
// are this page's own (what "recent" and "classic" mean) match the API's; the
// page takes "recent"'s first year from the overview's own recentFrom and
// computes it here only when there is no overview to ask.
//
// Pure: no React, no DOM.

import { siteTime } from "@/lib/seasonal/clock";
import type { FilterGenre } from "@/lib/contentLabels";
import { GRID_PAGE_SIZE, type DecadeKey, type GridView } from "./views";

/** "Recent" starts this many years before the current one (on the site's clock). */
export const RECENT_YEARS_BACK = 6;

/** "Classic" ends with this year. */
export const CLASSIC_LAST_YEAR = 2009;

/** The year the "old" decade bucket ends with. */
export const OLD_LAST_YEAR = 1969;

export type BrowseSort = "popularity" | "score";

export interface BrowseFilter {
  /** The AniList genre enum. */
  genre: FilterGenre;
  /** A second genre the titles must also carry. */
  with: FilterGenre | null;
  status: "RELEASING" | null;
  yearFrom: number | null;
  yearTo: number | null;
  sort: BrowseSort;
}

/** The first release year that counts as recent at `nowMs` — the API's own recentFrom. */
export function recentFromYear(nowMs: number): number {
  return siteTime(nowMs).year - RECENT_YEARS_BACK;
}

/** A decade's release years, inclusive; `old` has no lower bound. */
export function decadeRange(decade: DecadeKey): { from: number | null; to: number } {
  if (decade === "old") return { from: null, to: OLD_LAST_YEAR };
  const from = Number(decade);
  return { from, to: from + 9 };
}

/** The browse filter that lists `view` on `genre`'s page, with "recent" read at `recentFrom`. */
export function browseFilter(genre: FilterGenre, view: GridView, recentFrom: number): BrowseFilter {
  const base: BrowseFilter = { genre, with: null, status: null, yearFrom: null, yearTo: null, sort: "popularity" };
  if (view.kind === "with") return { ...base, with: view.with };
  if (view.kind === "decade") {
    const { from, to } = decadeRange(view.decade);
    return { ...base, yearFrom: from, yearTo: to };
  }
  switch (view.list) {
    case "airing":
      return { ...base, status: "RELEASING" };
    case "recent":
      return { ...base, yearFrom: recentFrom };
    case "classic":
      return { ...base, yearTo: CLASSIC_LAST_YEAR };
    case "top":
      return { ...base, sort: "score" };
    case "popular":
      return base;
  }
}

/**
 * The query string (no `?`) for one page of `filter`, in a fixed order so the
 * same request is always the same URL (and the same cache entry).
 */
export function browseQuery(filter: BrowseFilter, page: number, perPage: number = GRID_PAGE_SIZE): string {
  const params = new URLSearchParams();
  params.set("genre", filter.genre);
  if (filter.with) params.set("with", filter.with);
  if (filter.status) params.set("status", filter.status);
  if (filter.yearFrom !== null) params.set("yearFrom", String(filter.yearFrom));
  if (filter.yearTo !== null) params.set("yearTo", String(filter.yearTo));
  params.set("sort", filter.sort);
  params.set("page", String(page));
  params.set("perPage", String(perPage));
  return params.toString();
}

/** The path of one page of `filter` on the API. */
export function browsePath(filter: BrowseFilter, page: number, perPage: number = GRID_PAGE_SIZE): string {
  return `/api/anime/browse?${browseQuery(filter, page, perPage)}`;
}

/** The path of a genre's overview. */
export function overviewPath(genre: FilterGenre): string {
  return `/api/anime/genre-overview?${new URLSearchParams({ genre }).toString()}`;
}

// The grid view: one slice of a genre, a page at a time.
//
// The server renders the page the URL names. "Show more" under it is a real
// link to the next page (crawlers follow it, and so does a reader whose
// browser never ran the script); with the script, a press — or scrolling near
// it — fetches the next page and appends it instead.
//
// Pure: no React, no DOM.

import type { Lang } from "@/lib/i18n/lang";
import type { BrowseFilter } from "./api";
import type { GenreHubData } from "./hub";
import { toGenreItems, type GenreItem } from "./items";
import type { BrowsePage } from "./overview";
import { GRID_PAGE_SIZE, MAX_GRID_PAGE, type GridView } from "./views";

export interface GenreGridData {
  kind: "grid";
  view: GridView;
  /** The page the URL named. */
  page: number;
  /** Arrived by the old ?page=N address. */
  legacy: boolean;
  /** Every title in the slice. */
  total: number;
  items: GenreItem[];
  /** The request that lists the slice; the browser asks it for the pages after this one. */
  filter: BrowseFilter;
}

export type GenrePageData = GenreHubData | GenreGridData;

export function buildGridData(
  view: GridView,
  page: number,
  legacy: boolean,
  filter: BrowseFilter,
  answer: BrowsePage,
  lang: Lang,
): GenreGridData {
  return { kind: "grid", view, page, legacy, total: answer.total, items: toGenreItems(answer.rows, lang), filter };
}

/**
 * Pages the grid loads on its own as the reader scrolls near "show more"
 * (the server's page included). Past them a press is needed: a slice can run
 * to thousands of titles, and scrolling alone should not pile them all up.
 */
export const AUTO_LOAD_PAGES = 5;

/**
 * Pages the grid holds in place. Past them "show more" opens the next page as
 * a page of its own, which keeps the document to a few hundred cards.
 */
export const IN_PLACE_PAGES = 10;

/** Whether the grid, with `open` pages showing, loads the next one as the reader scrolls near it. */
export function autoLoads(open: number): boolean {
  return open < AUTO_LOAD_PAGES;
}

/** Whether, with `open` pages showing, the next one is appended here rather than opened as its own page. */
export function loadsInPlace(open: number): boolean {
  return open < IN_PLACE_PAGES;
}

/** Titles after page `lastPage` — "还有 N 部". */
export function titlesAfter(total: number, lastPage: number): number {
  return Math.max(0, total - lastPage * GRID_PAGE_SIZE);
}

/** Whether there is a page after `lastPage` the API will serve. */
export function hasPageAfter(total: number, lastPage: number): boolean {
  return lastPage < MAX_GRID_PAGE && titlesAfter(total, lastPage) > 0;
}

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

/** Titles after page `lastPage` — "还有 N 部". */
export function titlesAfter(total: number, lastPage: number): number {
  return Math.max(0, total - lastPage * GRID_PAGE_SIZE);
}

/** Whether there is a page after `lastPage` the API will serve. */
export function hasPageAfter(total: number, lastPage: number): boolean {
  return lastPage < MAX_GRID_PAGE && titlesAfter(total, lastPage) > 0;
}

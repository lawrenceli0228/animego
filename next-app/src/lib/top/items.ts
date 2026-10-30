// API rows → the items a ranking's cards draw.
//
// The genre page's items (lib/genre/items.ts: the seasonal page's, with the
// release year and season added, since a ranking spans years too) plus the
// show's place in the ranking. Unlike the genre page's they keep the
// synopsis: the chart view prints it.
//
// Pure: no React, no DOM.

import { releaseYear, type GenreItem } from "@/lib/genre/items";
import type { Lang } from "@/lib/i18n/lang";
import { toSeasonalItems } from "@/lib/seasonal/model";
import type { SeasonalAnime } from "@/lib/types";
import { TOP_SIZE } from "./rules";

/** One /api/anime/top row: the browse row, and its place in the ranking. */
export interface TopRow extends SeasonalAnime {
  rank?: number;
}

export interface TopItem extends GenreItem {
  /** 1 for the best-rated show. */
  place: number;
}

const SEASONS = new Set(["WINTER", "SPRING", "SUMMER", "FALL"]);

/** The rows out of the API's `data`: objects with an id, at most a ranking's worth. Never throws. */
export function parseTopRows(data: unknown): TopRow[] {
  if (!Array.isArray(data)) return [];
  return data
    .filter((r): r is TopRow => typeof r === "object" && r !== null && typeof (r as TopRow).anilistId === "number")
    .slice(0, TOP_SIZE);
}

/**
 * The rows as items, in ranking order, one per show. A row's place is the
 * API's rank when it carries a sane one, its position otherwise.
 */
export function toTopItems(rows: readonly TopRow[], lang: Lang): TopItem[] {
  const byId = new Map<number, { row: TopRow; index: number }>();
  rows.forEach((row, index) => {
    if (!byId.has(row.anilistId)) byId.set(row.anilistId, { row, index });
  });
  return toSeasonalItems(rows, lang).map((item) => {
    const hit = byId.get(item.id);
    const row = hit?.row;
    const rank = row?.rank;
    const season = row?.season && SEASONS.has(row.season) ? row.season : null;
    return {
      ...item,
      haystack: "",
      year: row ? releaseYear(row) : null,
      season,
      place: typeof rank === "number" && Number.isInteger(rank) && rank > 0 ? rank : (hit?.index ?? 0) + 1,
    };
  });
}

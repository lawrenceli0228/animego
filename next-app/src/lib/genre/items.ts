// API rows → the items the genre page's cards draw.
//
// The seasonal page's items (lib/seasonal/model.ts) with two things added and
// two taken away. Added: the release year and season, because a genre page
// spans decades and a card there says when a show is from. Taken away: the
// synopsis and the search haystack, which only the seasonal page's chart view
// and search box read — they are most of an item's weight in the page's
// payload and nothing here shows them.
//
// Pure: no React, no DOM.

import type { Lang } from "@/lib/i18n/lang";
import { toSeasonalItems, type SeasonalItem } from "@/lib/seasonal/model";
import type { SeasonalAnime } from "@/lib/types";

export interface GenreItem extends SeasonalItem {
  /** The release year: the season's year, or the premiere date's. */
  year: number | null;
  /** AniList season enum (WINTER…FALL), when the row has one. */
  season: string | null;
}

const SEASONS = new Set(["WINTER", "SPRING", "SUMMER", "FALL"]);

/** The year the catalogue files a row under — the same rule the API filters decades by. */
export function releaseYear(row: Pick<SeasonalAnime, "seasonYear" | "startDate">): number | null {
  const y = row.seasonYear;
  if (typeof y === "number" && Number.isInteger(y) && y >= 1900 && y <= 2100) return y;
  const head = typeof row.startDate === "string" ? row.startDate.slice(0, 4) : "";
  if (/^\d{4}$/.test(head)) {
    const n = Number(head);
    if (n >= 1900 && n <= 2100) return n;
  }
  return null;
}

/** The rows as items, in API order, one per anime. */
export function toGenreItems(rows: readonly SeasonalAnime[], lang: Lang): GenreItem[] {
  const byId = new Map<number, SeasonalAnime>();
  for (const row of rows) {
    if (row && typeof row.anilistId === "number" && !byId.has(row.anilistId)) byId.set(row.anilistId, row);
  }
  return toSeasonalItems(rows, lang).map((item) => {
    const row = byId.get(item.id);
    const season = row?.season && SEASONS.has(row.season) ? row.season : null;
    return {
      ...item,
      synopsis: "",
      haystack: "",
      year: row ? releaseYear(row) : null,
      season,
    };
  });
}

/**
 * Append `next` to `items`, leaving out any show already there. Popularity
 * moves between two page requests, and a show that slid from one page onto
 * the next must not be drawn twice.
 */
export function appendUnique(items: readonly GenreItem[], next: readonly GenreItem[]): GenreItem[] {
  const seen = new Set(items.map((i) => i.id));
  const out = [...items];
  for (const item of next) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

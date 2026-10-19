// The hub's genre strip: every browsable genre, with how many titles each has.
//
// The counts come from /api/anime/hubs, which every hub page and the sitemap
// already read. The strip always lists all of the genres in the site's order,
// whatever that answer holds — a genre the answer leaves out (or an answer
// that never came) is still a link, just without its number.
//
// Pure: no React, no DOM.

import type { FilterGenre } from "@/lib/contentLabels";
import { countOf } from "./overview";
import { STRIP_GENRES } from "./views";

export interface StripEntry {
  genre: FilterGenre;
  /** null when the count is not known. */
  count: number | null;
}

/** The strip from an /api/anime/hubs payload (or anything else, which leaves every count unknown). */
export function stripEntries(hubs: unknown): StripEntry[] {
  const counts = new Map<string, number>();
  const genres = typeof hubs === "object" && hubs !== null ? (hubs as { genres?: unknown }).genres : null;
  if (Array.isArray(genres)) {
    for (const g of genres) {
      if (typeof g !== "object" || g === null) continue;
      const { key, count } = g as { key?: unknown; count?: unknown };
      if (typeof key === "string" && !counts.has(key)) counts.set(key, countOf(count));
    }
  }
  return STRIP_GENRES.map((genre) => ({ genre, count: counts.has(genre) ? (counts.get(genre) as number) : null }));
}

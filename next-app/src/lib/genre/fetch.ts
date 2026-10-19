// The genre page's server-side requests. Every one of them answers something
// usable when the API does not: the same contract the hub pages and the
// seasonal page keep — an empty page over a 500, never a crash.

import { apiGetEnvelope } from "@/lib/api";
import type { FilterGenre } from "@/lib/contentLabels";
import { browsePath, overviewPath, type BrowseFilter } from "./api";
import { parseBrowsePage, parseOverview, type BrowsePage, type GenreOverview } from "./overview";
import { stripEntries, type StripEntry } from "./strip";

/**
 * How long a genre's answers may be reused. The page's own `revalidate` is
 * the same number, written out as a literal there (Next reads segment config
 * statically).
 */
export const GENRE_REVALIDATE = 300;

export async function fetchOverview(genre: FilterGenre): Promise<GenreOverview | null> {
  try {
    return parseOverview(await apiGetEnvelope<unknown>(overviewPath(genre), { revalidate: GENRE_REVALIDATE }), genre);
  } catch {
    return null;
  }
}

export async function fetchBrowsePage(filter: BrowseFilter, page: number): Promise<BrowsePage> {
  try {
    return parseBrowsePage(await apiGetEnvelope<unknown>(browsePath(filter, page), { revalidate: GENRE_REVALIDATE }));
  } catch {
    return { rows: [], total: 0 };
  }
}

export async function fetchStrip(): Promise<StripEntry[]> {
  try {
    const env = await apiGetEnvelope<{ data?: unknown }>("/api/anime/hubs", { revalidate: GENRE_REVALIDATE });
    return stripEntries(env?.data);
  } catch {
    return stripEntries(null);
  }
}

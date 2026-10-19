// The genre page's server-side requests. Every one of them answers something
// usable when the API does not: the same contract the hub pages and the
// seasonal page keep — an empty page over a 500, never a crash.
//
// All three are anonymous (`auth: false`). Their answers are the same for
// every reader, and Next keys its data cache on the request's headers as well
// as its URL: a request carrying the reader's cookie and address would be
// cached once per reader, which is no cache at all — and every one of those
// entries would crowd the shared in-memory cache the ISR pages live in.

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

/** Every request here: shared for GENRE_REVALIDATE, and anonymous (see above). */
export const GENRE_FETCH = { revalidate: GENRE_REVALIDATE, auth: false } as const;

export async function fetchOverview(genre: FilterGenre): Promise<GenreOverview | null> {
  try {
    return parseOverview(await apiGetEnvelope<unknown>(overviewPath(genre), GENRE_FETCH), genre);
  } catch {
    return null;
  }
}

export async function fetchBrowsePage(filter: BrowseFilter, page: number): Promise<BrowsePage> {
  try {
    return parseBrowsePage(await apiGetEnvelope<unknown>(browsePath(filter, page), GENRE_FETCH));
  } catch {
    return { rows: [], total: 0 };
  }
}

export async function fetchStrip(): Promise<StripEntry[]> {
  try {
    const env = await apiGetEnvelope<{ data?: unknown }>("/api/anime/hubs", GENRE_FETCH);
    return stripEntries(env?.data);
  } catch {
    return stripEntries(null);
  }
}

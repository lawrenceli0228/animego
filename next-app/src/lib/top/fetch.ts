// The ranking pages' server-side requests, and the home page's year list.
//
// Anonymous (`auth: false`), as the genre page's are: a ranking is the same
// for every reader, and Next keys its data cache on the request's headers as
// well as its URL — a request carrying the reader's cookie would be cached
// once per reader. One request shape per ranking (topApiPath), so the home
// page's year list and /top/{year} read the same cache entry and cannot
// disagree about who is first.
//
// Each answers null when the API does not: the page decides what that means
// (an empty list, never a crash or a 404 cached for five minutes).

import { apiGetEnvelope } from "@/lib/api";
import { parseTopRows, type TopRow } from "./items";
import { topApiPath, type TopFilters } from "./query";
import { parseTopYears, type TopYear } from "./years";

/**
 * How long a ranking may be reused. The pages' own `revalidate` is the same
 * number, written out as a literal there (Next reads segment config statically).
 */
export const TOP_REVALIDATE = 300;

const TOP_FETCH = { revalidate: TOP_REVALIDATE, auth: false } as const;

export async function fetchTopRows(state: TopFilters & { year: number | null }): Promise<TopRow[] | null> {
  const path = topApiPath(state);
  try {
    const env = await apiGetEnvelope<{ data?: unknown }>(path, TOP_FETCH);
    return parseTopRows(env?.data);
  } catch (err) {
    console.warn(`[top] ${path} failed:`, err);
    return null;
  }
}

export async function fetchTopYears(): Promise<TopYear[] | null> {
  try {
    const env = await apiGetEnvelope<{ data?: unknown }>("/api/anime/top/years", TOP_FETCH);
    return parseTopYears(env?.data);
  } catch (err) {
    console.warn("[top] /api/anime/top/years failed:", err);
    return null;
  }
}

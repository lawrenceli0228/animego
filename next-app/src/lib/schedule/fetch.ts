// The server-side fetches behind the schedule page, two of which the homepage
// makes too (its 今日更新 and 继续看). One module so the two pages cannot drift
// on caching or on what a failure means.
//
// Server-only in practice: apiGet forwards the request's cookies through
// next/headers. Every function here resolves rather than throws — a page
// renders its empty state instead of an error page when go-api is down.

import { apiGet, apiGetEnvelope, ApiError } from "@/lib/api";
import type { ScheduleResponse, WatchingItem } from "@/lib/types";
import type { SeasonYear } from "./season";

export const EMPTY_SCHEDULE: ScheduleResponse = { today: "", groups: {} };

/**
 * /api/anime/schedule. A rolling 7-day window keyed off the server's "today"
 * whose counts move within the day, so it is never served from a cache here.
 * A failure is EMPTY_SCHEDULE (`today: ""`), which both pages render as their
 * empty state.
 *
 * @param caller prefixes the warning, e.g. "HomePage".
 */
export async function fetchSchedule(caller: string): Promise<ScheduleResponse> {
  try {
    return await apiGet<ScheduleResponse>("/api/anime/schedule", { cache: "no-store" });
  } catch (err) {
    console.warn(`[${caller}] schedule fetch failed:`, err);
    return EMPTY_SCHEDULE;
  }
}

export interface WatchingResult {
  loggedOut: boolean;
  items: WatchingItem[];
  /**
   * The list could not be read for a reason other than the session — the
   * API down, a 5xx. `loggedOut` is true then as well, which is how the
   * homepage and the schedule page have always rendered it (as a visitor);
   * the 全部在追 page, which is behind the sign-in gate, tells the two apart.
   */
  unavailable: boolean;
}

/**
 * The signed-in reader's own watching list, read with their session cookie
 * on the server (apiGet forwards it), alongside the page's other data rather
 * than as a second round trip after it. Any failure — a 401 above all —
 * reads as "not signed in", which is what it has always meant here.
 *
 * Nothing runs in the browser for this: an anonymous visitor costs no
 * client-side auth request at all.
 */
export async function fetchWatching(): Promise<WatchingResult> {
  try {
    const items = await apiGet<WatchingItem[]>("/api/subscriptions?status=watching", { cache: "no-store" });
    return { loggedOut: false, items: Array.isArray(items) ? items : [], unavailable: false };
  } catch (err) {
    const signedOut = err instanceof ApiError && (err.status === 401 || err.status === 403);
    if (!signedOut) console.warn("[fetchWatching] watching list unavailable:", err);
    return { loggedOut: true, items: [], unavailable: !signedOut };
  }
}

/**
 * How many shows the catalogue has for a season — "已公布 N 部" on the
 * next-season link. Null when unknown; the link then leaves the count out.
 *
 * Public data, so it goes out anonymously (no cookie, cacheable for the
 * same five minutes as every other seasonal read).
 */
export async function fetchSeasonTotal({ season, year }: SeasonYear): Promise<number | null> {
  try {
    const body = await apiGetEnvelope<{ pagination?: { total?: number } }>(
      `/api/anime/seasonal?season=${season}&year=${year}&page=1&perPage=1`,
      { revalidate: 300, auth: false },
    );
    const total = body.pagination?.total;
    return typeof total === "number" && total >= 0 ? total : null;
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 404) {
      console.warn("[CalendarPage] season total fetch failed:", err);
    }
    return null;
  }
}

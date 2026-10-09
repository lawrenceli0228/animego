// Server-side reads for the community pages. Both are anonymous
// (`auth: false`) and ISR-cached (`revalidate: 60`, the detail page's window):
// the pages they feed are statically rendered and edge-cached for everyone,
// so they must not read a cookie or a header, and must not carry anything
// that differs per reader. The per-reader half is fetched in the browser —
// see components/community/SocialTab.tsx.

import { apiGet, ApiError } from "@/lib/api";
import { parseSummary, parseThreadView, type CommunitySummary, type CommunityThreadView } from "./types";

const REVALIDATE_SECONDS = 60;

/**
 * The tab's first page of everything, or null when it could not be read. A
 * failure here does not fail the page: the tab reads it again in the browser,
 * and an empty "还没有人写评价" baked into the cache would be a lie for a
 * minute.
 */
export async function loadCommunity(anilistId: number): Promise<CommunitySummary | null> {
  try {
    const data = await apiGet<unknown>(`/api/anime/${anilistId}/community`, {
      revalidate: REVALIDATE_SECONDS,
      auth: false,
    });
    return parseSummary(data);
  } catch {
    return null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A thread with its replies; null when it does not exist, was removed, or the id is not one. */
export async function loadThread(anilistId: number, threadId: string): Promise<CommunityThreadView | null> {
  if (!UUID.test(threadId)) return null;
  try {
    const data = await apiGet<unknown>(`/api/anime/${anilistId}/community/threads/${threadId}`, {
      revalidate: REVALIDATE_SECONDS,
      auth: false,
    });
    return parseThreadView(data);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 400)) return null;
    throw err;
  }
}

/** A thread id the route may ask the API about. */
export function isThreadId(value: string): boolean {
  return UUID.test(value);
}

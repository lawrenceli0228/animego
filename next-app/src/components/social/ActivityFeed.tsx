import { ApiError, apiGetEnvelope } from "@/lib/api";
import type { FeedItem, FeedResponse } from "@/lib/types";
import ActivityFeedView from "./ActivityFeedView";

// Keep the authenticated fetch in an RSC so the HttpOnly session cookie is
// forwarded server-to-server. Presentation is a client island because the
// canonical ISR render is zh while the language switch lives in the browser.
export default async function ActivityFeed() {
  let items: FeedItem[] = [];
  let state: "ok" | "anonymous" | "error" = "ok";
  try {
    const response = await apiGetEnvelope<FeedResponse>("/api/feed?page=1", {
      cache: "no-store",
    });
    items = Array.isArray(response.data) ? response.data : [];
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.status === 401 || error.status === 403)
    ) {
      state = "anonymous";
    } else {
      state = "error";
    }
  }
  // Capture once in the RSC payload so server markup and hydration use the
  // same clock value. `new Date().getTime()` is intentionally evaluated here,
  // not inside the client render.
  const nowMs = new Date().getTime();
  return <ActivityFeedView items={items} state={state} nowMs={nowMs} />;
}

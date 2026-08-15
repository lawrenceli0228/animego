export type CommunityEngagementEvent =
  | {
      eventType: "hot_discussions_impression";
      source: "home";
      anilistId?: never;
      episode?: never;
    }
  | {
      eventType: "discussion_open";
      source: "home";
      anilistId: number;
      episode: number;
    };

export function communityDiscussionTarget(
  anilistId: number,
  episode: number,
  commentId: string,
): string {
  if (!Number.isInteger(anilistId) || anilistId < 1) return "";
  if (!Number.isInteger(episode) || episode < 1) return "";
  const id = commentId.trim();
  if (!id) return "";
  return `/anime/${anilistId}#episode-${episode}-comment-${encodeURIComponent(id)}`;
}

export function engagementRequestBody(event: CommunityEngagementEvent): string {
  return JSON.stringify(event);
}

export function engagementSessionKey(
  kind: "impression" | "open",
  date: string,
): string {
  return `animego:community:hot-discussions:${kind}:${date}`;
}

function sendCommunityEngagement(event: CommunityEngagementEvent): void {
  if (typeof window === "undefined") return;
  void fetch("/api/community/engagement", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: engagementRequestBody(event),
    keepalive: true,
  }).catch(() => {
    // Product telemetry must never block navigation or surface a user error.
  });
}

export function trackHotDiscussionOpen(anilistId: number, episode: number): void {
  if (!Number.isInteger(anilistId) || anilistId < 1) return;
  if (!Number.isInteger(episode) || episode < 1) return;
  const date = new Date().toISOString().slice(0, 10);
  const key = engagementSessionKey("open", date);
  try {
    if (window.sessionStorage.getItem(key) === "1") return;
    window.sessionStorage.setItem(key, "1");
  } catch {
    // Storage can be disabled; keep navigation reliable and accept a noisy count.
  }
  sendCommunityEngagement({
    eventType: "discussion_open",
    source: "home",
    anilistId,
    episode,
  });
}

export function trackHotDiscussionsImpressionOnce(itemCount: number): boolean {
  if (typeof window === "undefined" || itemCount < 1) return false;
  const date = new Date().toISOString().slice(0, 10);
  const key = engagementSessionKey("impression", date);
  try {
    if (window.sessionStorage.getItem(key) === "1") return false;
    window.sessionStorage.setItem(key, "1");
  } catch {
    // Storage can be disabled; still record the visible section once per mount.
  }
  sendCommunityEngagement({
    eventType: "hot_discussions_impression",
    source: "home",
  });
  return true;
}

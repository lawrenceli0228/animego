// Events are grouped by whether they name an anime, not one arm per event,
// because that is the same line the database draws:
// community_engagement_target_chk has one branch for the untargeted events and
// one for discussion_open.  Keeping the two shapes in the same shape means a
// new untargeted event is one string in one union here and one string in one
// IN-list there, rather than a new arm in each that can disagree.
export type CommunityEngagementEvent =
  | {
      eventType:
        | "hot_discussions_impression"
        | "welcome_card_impression"
        | "welcome_card_open";
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

// The "hot-discussions" segment names the section, not the card: the welcome
// card lives inside that section's grid, so its keys belong under the same
// prefix.  The existing two values are load-bearing strings — changing them
// would reset every live session's dedupe at once and put a one-day spike in
// a series that is meant to be read as a trend.
type EngagementSessionKind =
  | "impression"
  | "open"
  | "welcome-impression"
  | "welcome-open";

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
  kind: EngagementSessionKind,
  date: string,
): string {
  return `animego:community:hot-discussions:${kind}:${date}`;
}

// Returns true when the caller should send, false when this browser has
// already sent that kind today.
//
// An unusable store counts as "not yet claimed" on purpose.  Safari's private
// mode throws on the property access itself, not only on write, so the choice
// there is between counting a repeat and dropping the event entirely — and a
// slightly noisy numerator is recoverable while a missing one is not.
function claimDailyOnce(kind: EngagementSessionKind): boolean {
  const key = engagementSessionKey(kind, new Date().toISOString().slice(0, 10));
  try {
    if (window.sessionStorage.getItem(key) === "1") return false;
    window.sessionStorage.setItem(key, "1");
  } catch {
    // Storage can be disabled; keep navigation reliable and accept a noisy count.
  }
  return true;
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
  if (!claimDailyOnce("open")) return;
  sendCommunityEngagement({
    eventType: "discussion_open",
    source: "home",
    anilistId,
    episode,
  });
}

export function trackHotDiscussionsImpressionOnce(itemCount: number): boolean {
  if (typeof window === "undefined" || itemCount < 1) return false;
  if (!claimDailyOnce("impression")) return false;
  sendCommunityEngagement({
    eventType: "hot_discussions_impression",
    source: "home",
  });
  return true;
}

// Deliberately takes no item count, and that is the whole point of it existing
// separately.
//
// The pinned /welcome card sits in the discussion grid but outside the
// `items.length` conditional — it renders whether or not there is anything to
// discuss.  trackHotDiscussionsImpressionOnce returns early when the list is
// empty, so on exactly those renders the card is on screen and clickable while
// the rail records no exposure at all.  Reusing that count as this card's
// denominator would divide by a number that omits those renders and overstate
// the click rate by however often the rail is empty.
export function trackWelcomeCardImpressionOnce(): boolean {
  if (typeof window === "undefined") return false;
  if (!claimDailyOnce("welcome-impression")) return false;
  sendCommunityEngagement({
    eventType: "welcome_card_impression",
    source: "home",
  });
  return true;
}

export function trackWelcomeCardOpen(): void {
  if (typeof window === "undefined") return;
  if (!claimDailyOnce("welcome-open")) return;
  sendCommunityEngagement({
    eventType: "welcome_card_open",
    source: "home",
  });
}

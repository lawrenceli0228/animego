// The client half of the activity record: page arrivals and video starts.
//
// WHY A BEACON AT ALL, WHEN THE SERVER ALREADY SEES EVERY REQUEST.
//
// Two facts about a visit are not derivable from server logs. A soft
// navigation between two already-cached routes issues no API call, so the
// request-derived record simply does not contain it. And arriving at a player
// is not the same event as pressing play, though both live at one URL.
//
// WHAT IT IS NOT. It is not the source of DAU/WAU/MAU or retention — those
// come from the server-side, token-derived record and cannot be forged.
// Anything reported from here is a counter a stranger can move, which is why
// the endpoint takes no magnitude (the increment is a fixed +1 in SQL) and why
// the only caller-controlled value is a label that gets collapsed onto a
// ten-value allow-list before it reaches the database.
//
// WHAT IT COSTS. One `keepalive` POST per navigation, fire-and-forget, no
// response read. The endpoint it hits does no database work at all: both
// counters are in-memory increments flushed once a minute by a background
// goroutine, so the site's whole logged-out page-view volume does not end up
// serialised behind one row lock. See go-api/internal/activity/recorder.go.

import { splitLocale } from "@/lib/i18n/locale";

/**
 * The coarse buckets the server will accept.
 *
 * MUST stay a subset of the allow-list in
 * go-api/internal/activity/activity.go and of the CHECK constraint on
 * activity_surface_daily (migration 0025). An unfamiliar value is not
 * rejected — the server collapses it to "other" — so a drift here loses a
 * label rather than a count. Deliberate: a page that ships before somebody
 * adds its name should still be counted.
 */
export type ActivitySurface =
  | "home"
  | "anime"
  | "watch"
  | "seasonal"
  | "library"
  | "community"
  | "profile"
  | "search"
  | "auth"
  | "other";

export type ActivityKind = "page_view" | "playback";

/**
 * Route prefix → surface, longest-first is unnecessary because no prefix here
 * is a prefix of another.
 *
 * Deliberately coarse. The finest thing this feature ever stores about where
 * anybody went is one of these ten words, aggregated per day with no user
 * column. A path or a title id would turn the same table into a browsing
 * history, which is the line migration 0020 already drew for community
 * telemetry and this re-draws.
 */
const SURFACE_BY_PREFIX: ReadonlyArray<readonly [string, ActivitySurface]> = [
  ["/anime", "anime"],
  // The player route. Named "watch" rather than "player" because the metric
  // is about the act, not the component.
  ["/player", "watch"],
  ["/seasonal", "seasonal"],
  ["/calendar", "seasonal"],
  ["/library", "library"],
  ["/search", "search"],
  // Three addresses for one idea: somebody's profile, mine, and mine in edit
  // mode. Splitting them would add resolution nobody has asked a question
  // about.
  ["/u", "profile"],
  ["/profile", "profile"],
  ["/settings", "profile"],
  ["/login", "auth"],
  ["/register", "auth"],
  ["/forgot-password", "auth"],
  ["/reset-password", "auth"],
];

/**
 * Which surface a browser pathname belongs to.
 *
 * Locale-agnostic: "/en/anime/21" and "/anime/21" are the same surface, and
 * the prefix is stripped with the same splitLocale the router uses so this
 * cannot drift from the published locale vocabulary. Getting that wrong would
 * file every non-default-locale visit under "other" — a slow, plausible-looking
 * corruption of the one number anonymous readers contribute to.
 *
 * Exported for its own test; the component below is the only production caller.
 */
export function surfaceForPath(pathname: string): ActivitySurface {
  if (!pathname) return "other";
  const { path } = splitLocale(pathname);
  if (path === "/" || path === "") return "home";
  for (const [prefix, surface] of SURFACE_BY_PREFIX) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return surface;
  }
  return "other";
}

/**
 * Post one beacon. Never throws, never awaits, never reads the response.
 *
 * `keepalive` so a report fired during a navigation is not cancelled when the
 * page it came from goes away — the same reason lib/communityEngagement.ts
 * uses it. `credentials: "include"` is what lets the server attribute the two
 * per-user counters; without a session it simply lands in the anonymous
 * aggregate.
 */
export function sendActivityBeacon(kind: ActivityKind, surface: ActivitySurface): void {
  if (typeof window === "undefined") return;
  void fetch("/api/activity/beacon", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, surface }),
    keepalive: true,
  }).catch(() => {
    // Telemetry must never surface as a user-visible error or block a
    // navigation. A dropped beacon costs one count on a directional metric.
  });
}

/**
 * Report that a video started playing on the current page.
 *
 * Separate from the page view because arriving at a player and pressing play
 * are different events, and the gap between them is the interesting one.
 */
export function trackPlaybackStart(pathname: string): void {
  sendActivityBeacon("playback", surfaceForPath(pathname));
}

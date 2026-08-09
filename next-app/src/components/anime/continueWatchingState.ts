// Pure logic behind ContinueWatching.tsx, split out so bun:test can reach it
// without rendering the RSC (next-app tests lib-style modules, not JSX —
// same split as torrentModalLogic.ts next door).

import type { SubscriptionChangeDetail } from "@/lib/subscriptionBus";

/** Which of the three ContinueWatching bodies the section renders. */
export type WatchingView = "logged-out" | "empty" | "grid";

/**
 * Three states, not two. `empty` is the one that used to be a `return null`:
 * an account with zero subscriptions saw *less* on the homepage than the
 * anonymous visitor who at least got the blurred stub + CTA, so registering
 * made the page emptier and said nothing about what to do next.
 */
export function resolveWatchingView(
  loggedOut: boolean,
  itemCount: number,
): WatchingView {
  if (loggedOut) return "logged-out";
  return itemCount === 0 ? "empty" : "grid";
}

/**
 * Does this subscriptionBus event mean the "nothing here yet" copy has just
 * become a lie?
 *
 * The homepage renders the empty stub from a SERVER read of
 * `/api/subscriptions?status=watching`. When the visitor then presses + on a
 * poster in the trending grid directly above it, that server answer is stale
 * and the section sits there telling them they are not tracking anything —
 * two seconds after they tracked something, on the same screen.
 *
 * Only `watching` counts, because only `watching` is what this section asked
 * the server for. A detail page marking something `completed` or `dropped`
 * broadcasts here too and must NOT flip the copy: those rows would not appear
 * in the grid on the next load either, so promising otherwise just moves the
 * contradiction one page-load later. `sub: null` is a removal — likewise no.
 */
export function isWatchingArrival(detail: SubscriptionChangeDetail): boolean {
  return detail.sub?.status === "watching";
}

/**
 * Fold one bus event into the set of rows added since the server rendered
 * this section.
 *
 * A set rather than a boolean because the swap has to be reversible. The
 * success toast for a quick-add carries an Undo, and a one-way flag would
 * leave the section reading "added to Watching" after the user took it back —
 * the same self-contradiction, just inverted. Non-arrivals therefore *drop*
 * the id: that covers the DELETE (`sub: null`) and the detail page moving a
 * row to completed or dropped, both of which take it out of the
 * `?status=watching` answer the section is standing in for.
 *
 * Returns the same reference when nothing changed, so the echo of our own
 * write costs no re-render.
 */
export function nextWatchingIds(
  current: ReadonlySet<number>,
  detail: SubscriptionChangeDetail,
): ReadonlySet<number> {
  const wanted = isWatchingArrival(detail);
  if (current.has(detail.anilistId) === wanted) return current;
  const next = new Set(current);
  if (wanted) next.add(detail.anilistId);
  else next.delete(detail.anilistId);
  return next;
}

// Route slugs of /seasonal/[season]/[year], indexed by calendar quarter.
const SEASON_SLUGS = ["winter", "spring", "summer", "fall"] as const;

/**
 * Href of the season we are currently in, e.g. `/seasonal/summer/2026`.
 *
 * Derived from the clock on every render rather than pinned to a constant:
 * sitemap.ts hardcoded `spring/2026` and was still pointing crawlers at a
 * two-quarters-stale page in August. Quarter boundaries match the
 * `getCurrentSeason()` copies in layout.tsx / page.tsx / not-found.tsx
 * (Jan–Mar winter, Apr–Jun spring, Jul–Sep summer, Oct–Dec fall).
 */
export function currentSeasonHref(now: Date = new Date()): string {
  const slug = SEASON_SLUGS[Math.floor(now.getMonth() / 3)];
  return `/seasonal/${slug}/${now.getFullYear()}`;
}

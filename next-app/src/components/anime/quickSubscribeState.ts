// The quick-subscribe button's decisions, with no React and no toast attached.
//
// Split out for the same reason as subscriptionSetState: importing the
// component pulls react-hot-toast, which pulls goober, which touches
// `document` while the module is still being evaluated. bun:test has no DOM,
// so the whole suite aborted in CI before its first assertion — and passed
// locally only because another file had already leaked a `document` global
// into the shared process. Tests that depend on file ordering are not tests.
//
// Everything here is string/enum in, string/enum out.

import type { SubStatus, SubscriptionDoc } from "@/lib/subscriptionBus";

/** What the button means right now. */
export type QuickSubscribeMode = "signedOut" | "add" | "open";

/**
 * Collapse the two provider flags into the single decision the button renders
 * and acts on.
 *
 * `known === false` wins outright: that covers anonymous visitors, a page that
 * forgot the provider, and a session that 401'd mid-visit. In all three the
 * only honest affordance is "log in first" — showing ✓ off a stale set would
 * promise a write we cannot make.
 *
 * The subscribed mode is called `open`, not `remove`, on purpose: the name is
 * the contract. Whatever status the row carries — watching, completed,
 * dropped — the answer from a poster corner is "go to the detail page", so
 * there is no branch here that could ever grow a DELETE. The seasonal page's
 * ✓ is the one exception, and it is not built on this mode alone: it unfollows
 * through DELETE ?ifUntouched=1, which the server refuses for any row with
 * history, and asks first before the plain one (useQuickSubscribe.unfollow).
 */
export function quickSubscribeMode(
  known: boolean,
  subscribed: boolean,
): QuickSubscribeMode {
  if (!known) return "signedOut";
  return subscribed ? "open" : "add";
}

/**
 * Build the /login round-trip URL that brings the visitor back to this exact
 * grid — same page, same filters, same search query — so the poster they
 * pressed is still on screen when the pending write lands.
 */
export function loginTarget(pathname: string, search: string): string {
  const from = `${pathname}${search}` || "/";
  return `/login?from=${encodeURIComponent(from)}`;
}

/** Where ✓ sends the viewer: the surface that owns every other subscription verb. */
export function detailTarget(anilistId: number): string {
  return `/anime/${anilistId}`;
}

/** The words for what a row holds, already in the page's language. */
export interface UnfollowFactCopy {
  /** "看到第 {{ep}} 集" */
  episode: string;
  /** "评分 {{score}}" */
  score: string;
  statuses: Record<SubStatus, string>;
}

/**
 * What unfollowing would take, as short phrases for the question asked first:
 * the progress, the score, and the status when it is not the quick-add one.
 * Empty when the history is somewhere these do not reach — watch time with
 * every mark taken back, a reply or a like on the status card — or the read
 * failed; the dialog's sentence still says what goes.
 */
export function unfollowFacts(doc: SubscriptionDoc | null, copy: UnfollowFactCopy): string[] {
  if (!doc) return [];
  const facts: string[] = [];
  if (doc.currentEpisode > 0) facts.push(copy.episode.split("{{ep}}").join(String(doc.currentEpisode)));
  if (doc.score != null) facts.push(copy.score.split("{{score}}").join(String(doc.score)));
  if (doc.status !== "watching") facts.push(copy.statuses[doc.status] ?? doc.status);
  return facts;
}

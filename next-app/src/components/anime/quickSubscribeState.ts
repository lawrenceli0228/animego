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
 * dropped — the answer from this corner is always "go to the detail page",
 * so there is no branch here that could ever grow a DELETE.
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

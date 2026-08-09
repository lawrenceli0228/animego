// Generation side of the ?from= round-trip — the counterpart to
// sanitizeFromParam in @/lib/authForm, which is the consumption side.
//
// proxy.ts already stamps ?from= onto the gated routes it guards
// (/admin, /library, /player). Everything else that sends a user to an
// auth surface does it from inside a page — "登录后发表评论", the follow
// button on someone's profile, the "no account? register" footer on the
// login form — and every one of those linked to a bare "/login" or
// "/register". sanitizeFromParam(undefined) then falls back to "/", so
// the intent that carried the user to the gate ("comment on THIS
// episode", "follow THIS person", "open my settings") evaporated and
// they landed on the home page instead.
//
// The same-origin allowlist below deliberately MIRRORS sanitizeFromParam
// instead of importing it. Reason: emitting a value the consumer will
// throw away is a silent no-op — the link looks like it carries intent
// and doesn't. Enforcing the rule on both ends means an unusable path
// degrades visibly to the bare surface here rather than shipping a dead
// query param. Keep the two in sync; src/lib/authForm.ts is the source
// of truth for the rule itself.

/** The two auth surfaces that accept a ?from= round-trip. */
export type AuthSurface = "/login" | "/register";

// Mirror of SELF_LOOP_TARGETS in @/lib/authForm. /login?from=/login (or
// the /register twin) would bounce the user straight back into the form
// they just cleared, so those never become a `from` value — on either
// end of the trip.
const AUTH_SURFACES: readonly string[] = ["/login", "/register"];

// Same positive allowlist as sanitizeFromParam: "/" followed by an ASCII
// alphanumeric. One rule closes protocol-relative ("//evil.com"),
// fully-qualified ("https://evil.com"), scheme ("javascript:...") and
// control-char-prefixed values — and, conveniently here, the bare root
// "/" as well, since both surfaces already default there and a
// "?from=%2F" would be pure URL noise.
const SAME_ORIGIN_PATH = /^\/[A-Za-z0-9]/;

/**
 * Build the href for an auth surface, carrying `from` when it can
 * survive the round-trip.
 *
 * @param surface "/login" or "/register".
 * @param from Same-origin path to return to after auth — a pathname,
 *   optionally with its query/hash (proxy.ts uses pathname+search, and
 *   the `from` prop the auth forms already hold has that shape). Never
 *   pass a full URL or anything user-controlled beyond a path: the
 *   allowlist rejects it, but the caller shouldn't be relying on that.
 * @returns The bare surface when `from` is absent, the root, or
 *   unusable; otherwise `${surface}?from=<encoded>`.
 */
export function authHrefWithFrom(
  surface: AuthSurface,
  from: string | null | undefined,
): string {
  if (!isRoundTrippable(from)) return surface;
  // encodeURIComponent, not raw interpolation: a path legitimately
  // contains "/" and can contain "?", "&" and "#" (proxy.ts hands over
  // pathname+search), all of which would otherwise be parsed as query
  // structure by the receiving page instead of as part of the value.
  return `${surface}?from=${encodeURIComponent(from)}`;
}

function isRoundTrippable(value: string | null | undefined): value is string {
  if (typeof value !== "string") return false;
  if (!SAME_ORIGIN_PATH.test(value)) return false;
  // Boundary-aware: "/loginfoo" is a real, unrelated route and stays
  // eligible — only the surface itself, or the surface plus its query /
  // hash, is a self-loop. Matches sanitizeFromParam exactly.
  return !AUTH_SURFACES.some(
    (surface) =>
      value === surface ||
      value.startsWith(`${surface}?`) ||
      value.startsWith(`${surface}#`),
  );
}

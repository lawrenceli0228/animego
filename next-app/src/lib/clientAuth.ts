// Client-side login hint, derived from the non-httpOnly `auth_hint` cookie.
//
// go-api sets `auth_hint=1` (NON-httpOnly, NO secret — it only signals "a
// session probably exists") on login / register / refresh and clears it on
// logout. Client JS can read it; the real `session` / `refreshToken` cookies
// stay httpOnly and unreadable here.
//
// This replaces the old server-side `loggedInFromCookies` gate (which forced
// the detail page to read `cookies()` and render dynamically). Reading the
// hint on the client instead lets /anime/[id] stay statically prerendered /
// ISR-cacheable while still skipping the mount-time subscription probe for
// logged-out visitors (ISSUE-001). authFetch's 401 → anonymous handling
// remains the source of truth; this is only a probe gate.
//
// The `\b` after `auth_hint=1` prevents a sloppy match on a hypothetical
// `auth_hint=10`-style value, and the leading `(?:^|;\s*)` anchors to a real
// cookie boundary so a `not_auth_hint=1` substring never counts.
export function hasAuthHint(): boolean {
  return (
    typeof document !== "undefined" &&
    /(?:^|;\s*)auth_hint=1\b/.test(document.cookie)
  );
}

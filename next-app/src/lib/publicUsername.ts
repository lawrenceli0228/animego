// Recognising the masked handle the API hands out for users whose username
// is contact-shaped.
//
// go-api/internal/pii replaces a username that looks like an email address or
// a phone number with `user-` + the first ten hex characters of its MD5,
// because the username is a public display name AND the /u/{username} routing
// key, and it reaches anonymous endpoints — including the watcher list that
// gets server-rendered into the Cloudflare-cached /anime/{id} page.
//
// The frontend cannot tell a masked handle from a real username by asking the
// API (the field is the same `username` string either way), so it matches the
// shape.  The shape is a real contract, not a guess: the same `user-` prefix
// is what `GetUserIDByPublicSlug` reverses in SQL, so it cannot drift without
// breaking profile links first.
//
// A real username could in principle be exactly `user-` followed by ten
// lowercase hex digits.  The only consequence is a tooltip shown to someone
// who did not need it, so the pattern is deliberately strict rather than
// defensive.

/** The prefix go-api/internal/pii puts on a masked handle. */
export const MASKED_USERNAME_PREFIX = "user-";

/** `user-` plus exactly ten lowercase hex characters, anchored. */
const MASKED_USERNAME_RE = /^user-[0-9a-f]{10}$/;

/**
 * True when `username` is a masked handle rather than a name its owner chose.
 *
 * Use it to decide whether to explain the placeholder to the viewer — never
 * to decide whether to link to the profile. Masked handles resolve: the
 * profile lookup falls back to a slug query precisely so these users stay
 * reachable.
 */
export function isMaskedUsername(username: string | null | undefined): boolean {
  if (!username) return false;
  return MASKED_USERNAME_RE.test(username);
}

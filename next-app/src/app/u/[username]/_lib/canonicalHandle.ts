// Resolving a /u/ path param to the handle that is allowed to be shown.
//
// The API answers to both a stored username and the masked handle that
// go-api/internal/pii substitutes for contact-shaped ones, but only the
// handle may appear on screen or in a URL. Every /u/ route renders its path
// param — into the title, the canonical, the back-link, the pagination hrefs
// — so a request carrying the raw form would put it all back on the page.
// That is the one surface the serialization masking cannot reach, because
// these routes render the param rather than a response field.
//
// The check asks the API rather than re-deriving "is this contact-shaped?"
// in TypeScript. A second copy of that rule would drift from the Go one, and
// the failure mode is rendering an address while believing it is fine.

import { apiGet, ApiError } from "@/lib/api";

interface ProfileHandle {
  username: string;
}

/**
 * The handle this profile should be addressed by, or `null` when it could not
 * be established — no such user, or the lookup failed.
 *
 * The two failure modes collapse into one return value on purpose. Echoing
 * the input back on an error would be the safe default for a redirect
 * decision but the wrong one for a title: a flaky request would put the
 * address straight back into the head, which is the leak this exists to
 * close. Callers pick their own behaviour for `null`, and both choices are
 * safe:
 *
 *   - metadata falls back to a neutral title, naming nobody
 *   - the list routes simply do not redirect, and their own fetch still
 *     404s if the user genuinely does not exist
 */
export async function canonicalHandle(handle: string): Promise<string | null> {
  try {
    const data = await apiGet<ProfileHandle>(
      `/api/users/${encodePathSegment(handle)}`,
      { cache: "no-store" },
    );
    return data?.username ?? null;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    return null;
  }
}

/**
 * `encodeURIComponent` for a path segment, minus the over-encoding of `@`.
 *
 * RFC 3986 allows `@` unescaped in a path segment, but encodeURIComponent
 * percent-encodes it anyway, and the Go router matches the literal — so
 * `/api/users/x%40y.com` 404s while `/api/users/x@y.com` resolves. Without
 * this, the exact handles that need resolving (the contact-shaped ones) are
 * the only ones that never resolve, and the caller silently falls back to
 * "unknown user".
 */
export function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%40/g, "@");
}

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
 * The handle this profile should be addressed by.
 *
 * Returns `null` when there is no such user — callers map that to
 * `notFound()`, matching what the list endpoints already do on 404.
 */
export async function canonicalHandle(handle: string): Promise<string | null> {
  try {
    const data = await apiGet<ProfileHandle>(
      `/api/users/${encodeURIComponent(handle)}`,
      { cache: "no-store" },
    );
    return data?.username ?? null;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    // Any other failure (500, network) must not decide the URL. Returning
    // the input leaves the page to render as before rather than bouncing
    // the visitor somewhere on the strength of a failed request.
    return handle;
  }
}

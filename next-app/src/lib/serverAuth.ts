// Server-side login signal derived from the request's auth cookies.
//
// go-api sets two httpOnly cookies: `session` (15m access JWT) and
// `refreshToken` (14d). Both are httpOnly, so client components can't read
// them — only an RSC (which calls `cookies()`) can. A request carrying
// EITHER cookie is treated as logged in:
//   - session present                → logged in (access token live).
//   - refreshToken present, no session → still logged in; the access token
//     expired but authFetch will refresh on the first 401.
//   - neither                        → logged out (the SEO organic visitor).
//
// Used to gate the client-side subscription probes on the anime detail page
// so logged-out views don't 401-storm (ISSUE-001). See
// SubscriptionButton.tsx / EpisodesGrid.tsx.

type CookieReader = { has(name: string): boolean };

export function loggedInFromCookies(store: CookieReader): boolean {
  return store.has("session") || store.has("refreshToken");
}

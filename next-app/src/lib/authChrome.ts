// Which auth chrome a client island should render. Shared by Navbar and
// EpisodeComments (both render a logged-in UI / a neutral probe placeholder / a
// logged-out CTA off the same two inputs).
//
// THE INVARIANT (this is the whole point of the phantom-logout fix): while the
// auth_hint-gated /api/auth/me probe is in flight and we are NOT yet
// authenticated, the answer is "probing" — a neutral placeholder — NEVER
// "anonymous" (the login CTA). A logged-in visitor always carries the 7-day
// auth_hint cookie, so they enter the "probing" path and never flash the login
// button before their avatar / comment box resolves.
//
//   isAuthed │ probing │ result
//   ─────────┼─────────┼────────────
//     true   │  any    │ "authed"      (a resolved session always wins)
//     false  │  true   │ "probing"     (probe in flight → neutral placeholder)
//     false  │  false  │ "anonymous"   (probe resolved to no session → login CTA)

export type AuthChrome = "authed" | "probing" | "anonymous";

/**
 * @param isAuthed Whether a user session has resolved (truthy `user`).
 * @param probing  Whether the auth_hint-gated /api/auth/me probe is in flight.
 */
export function authChrome(isAuthed: boolean, probing: boolean): AuthChrome {
  if (isAuthed) return "authed";
  if (probing) return "probing";
  return "anonymous";
}

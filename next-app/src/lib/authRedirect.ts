// Post-auth redirect. Shared by LoginForm and RegisterForm.
//
// Deliberately a FULL navigation (`window.location.replace`), NOT a Next
// `router.replace` + `router.refresh`. The Navbar is a client island that reads
// the `auth_hint` cookie and probes `/api/auth/me` in its OWN effect (the root
// layout no longer fetches auth server-side). A soft router.replace only
// re-triggers that effect on the pathname change, and racily — it can read
// document.cookie before the login/register response's Set-Cookie is committed,
// leaving the nav stuck "logged out" until a manual refresh. A full navigation
// remounts everything with the cookies already in the jar (exactly what that
// manual refresh does), so the nav reliably shows logged-in.
//
// `replace` (not `assign`) so /login or /register don't sit in history behind
// the now-authenticated landing page.

/**
 * Send a freshly-authenticated user to their post-auth target via a full page
 * navigation.
 *
 * @param target Server-sanitized same-origin path (see authForm
 *   `sanitizeFromParam`) — always starts with "/" and is never /login|/register.
 */
export function redirectAfterAuth(target: string): void {
  if (typeof window === "undefined") return;
  window.location.replace(target);
}

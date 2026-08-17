// P9 /reset-password/:token port — submit helper.
//
// Mirror of submitRegister. POST /api/auth/reset-password/:token with
// the new password; backend returns 200 + invalidates user.refreshToken
// on success (auth.controller.js:190). No cookies are set by this call
// — the form drives the user to /login afterwards.
//
// Token is encodeURIComponent'd defensively. Today the backend mints
// hex-only tokens (crypto.randomBytes(32).toString('hex')) so no
// escaping is needed, but if the encoding ever moves to base64url or
// any character outside [A-Za-z0-9._~-] we don't want this helper to
// be the thing that breaks.

import {
  type AuthSubmitOptions,
  type SubmitResult,
  extractServerMessage,
} from "@/lib/authForm";

const DEFAULT_FAIL_MESSAGE = "Password reset failed";

export async function submitResetPassword(
  token: string,
  password: string,
  opts: AuthSubmitOptions = {},
): Promise<SubmitResult> {
  const fetchImpl = opts.fetchFn ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(
      `/api/auth/reset-password/${encodeURIComponent(token)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ password }),
        signal: opts.signal,
      },
    );
  } catch (err) {
    return {
      ok: false,
      status: 0,
      message: err instanceof Error && err.message ? err.message : DEFAULT_FAIL_MESSAGE,
    };
  }

  if (res.ok) return { ok: true, status: res.status, message: "" };

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON error body — fall through to status-only message */
  }

  const message = extractServerMessage(body) ?? `HTTP ${res.status}`;
  return { ok: false, status: res.status, message };
}

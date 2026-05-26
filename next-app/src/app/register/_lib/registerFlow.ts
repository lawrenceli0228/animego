// P9 /register port — submit helper.
//
// Mirror of submitLogin. POST /api/auth/register with three fields
// (username, email, password). Backend returns 201 on success and
// sets the same session + refreshToken cookies as /login, so the
// post-submit redirect + router.refresh dance works identically.
//
// Shared bits (sanitizeFromParam, extractServerMessage, SubmitResult)
// live in lib/authForm.ts — see comment there for the rationale.

import {
  type AuthSubmitOptions,
  type SubmitResult,
  extractServerMessage,
} from "@/lib/authForm";

const DEFAULT_FAIL_MESSAGE = "Registration failed";

export async function submitRegister(
  username: string,
  email: string,
  password: string,
  opts: AuthSubmitOptions = {},
): Promise<SubmitResult> {
  const fetchImpl = opts.fetchFn ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ username, email, password }),
      signal: opts.signal,
    });
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

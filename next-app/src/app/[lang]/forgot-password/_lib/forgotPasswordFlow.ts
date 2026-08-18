// P9 /forgot-password port — submit helper.
//
// Mirror of submitLogin / submitRegister, but the backend contract is
// privacy-preserving: POST /api/auth/forgot-password always returns
// 200 with `{ data: { message } }` regardless of whether the email is
// registered (server/controllers/auth.controller.js:146-166). So the
// only non-ok paths are network failures and 429 from authLimiter.
//
// Shared bits (extractServerMessage, SubmitResult, AuthSubmitOptions)
// live in lib/authForm.ts.

import {
  type AuthSubmitOptions,
  type SubmitResult,
  extractServerMessage,
} from "@/lib/authForm";

const DEFAULT_FAIL_MESSAGE = "Forgot password request failed";

export async function submitForgotPassword(
  email: string,
  opts: AuthSubmitOptions = {},
): Promise<SubmitResult> {
  const fetchImpl = opts.fetchFn ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl("/api/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ email }),
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

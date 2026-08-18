// P9 /login port — submit helper.
//
// Pure helper for the LoginForm shell: POST /api/auth/login with the
// browser's session cookie semantics ("same-origin" so the Set-Cookie
// response lands in the jar), narrow the response, return the uniform
// SubmitResult shape so the consumer can render an inline error.
//
// sanitizeFromParam + extractServerMessage live in lib/authForm.ts
// because /register, /forgot-password, and /reset-password share both.

import {
  type AuthSubmitOptions,
  type SubmitResult,
  extractServerMessage,
} from "@/lib/authForm";

const DEFAULT_FAIL_MESSAGE = "Login failed";

export async function submitLogin(
  email: string,
  password: string,
  opts: AuthSubmitOptions = {},
): Promise<SubmitResult> {
  const fetchImpl = opts.fetchFn ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ email, password }),
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

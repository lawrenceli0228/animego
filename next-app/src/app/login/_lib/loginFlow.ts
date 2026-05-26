// P9 /login port — flow helpers extracted from LoginForm.
//
// Two pure helpers:
//
//   sanitizeFromParam(raw) — clean the ?from= round-trip value so it
//   stays a same-origin path. proxy.ts populates `from` with the
//   gated request's pathname+search, but the value still arrives via
//   the URL bar and so could be hand-edited to "//evil.com" or
//   "https://evil.com" (open-redirect class). We restrict to a
//   single leading "/" followed by a non-"/" char.
//
//   submitLogin(email, password, opts?) — POST /api/auth/login with
//   credentials, narrow the response, return a discriminated result
//   for the component to render. Browser captures the Set-Cookie
//   response (session + refreshToken) on the success branch; the
//   caller follows up with router.push + router.refresh.
//
// The component shell stays a thin wrapper so this module covers the
// non-DOM logic under bun:test (no React Testing Library in this repo;
// proxy.test.ts / authFetch.test.ts are the precedent).

export interface SubmitLoginOptions {
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
}

// Uniform shape on both branches so the union narrows trivially at
// call sites — the alternative ({ok:true} | {ok:false; status; message})
// confuses TypeScript's flow analysis in the LoginForm consumer.
export interface SubmitLoginResult {
  ok: boolean;
  status: number;
  message: string;
}

interface ServerErrorBody {
  error?: { code?: string; message?: string };
}

const DEFAULT_FAIL_MESSAGE = "Login failed";

export async function submitLogin(
  email: string,
  password: string,
  opts: SubmitLoginOptions = {},
): Promise<SubmitLoginResult> {
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

function extractServerMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const err = (body as ServerErrorBody).error;
  if (!err || typeof err !== "object") return null;
  const msg = err.message;
  return typeof msg === "string" && msg.length > 0 ? msg : null;
}

// Restrict `from` to a same-origin absolute path. Allowlist is "/X..."
// where X is ASCII alphanumeric — chosen because every gated route
// (proxy.ts matcher: /admin, /library, /player) begins that way, as do
// /search /seasonal /welcome etc. A positive allowlist closes the gap
// the previous denylist had against null/tab/control-char second
// characters that some clients normalize to "/" before navigating.
//
// Also reject the bare "/login" target so a stale tab POSTing the page
// back to itself doesn't loop. Next.js URL-decodes searchParams before
// they reach this function (e.g. "%2F%2Fevil.com" arrives as
// "//evil.com"), so percent-encoded protocol-relative attacks are
// caught by the second-char rule too.
export function sanitizeFromParam(raw: string | string[] | undefined): string {
  const FALLBACK = "/";
  if (raw === undefined) return FALLBACK;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return FALLBACK;
  if (!/^\/[A-Za-z0-9]/.test(value)) return FALLBACK;
  if (value === "/login" || value.startsWith("/login?") || value.startsWith("/login#")) {
    return FALLBACK;
  }
  return value;
}

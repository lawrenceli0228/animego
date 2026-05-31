// P9 — shared helpers for the auth form surfaces (/login, /register,
// later /forgot-password and /reset-password/:token).
//
// Two pure helpers extracted from the original /login port:
//
//   sanitizeFromParam(raw) — clean the ?from= round-trip value so it
//   stays a same-origin path. proxy.ts populates `from` with the gated
//   request's pathname+search, but the value still arrives via the URL
//   bar and can be hand-edited to "//evil.com", "https://evil.com",
//   "javascript:..." or control-char prefixes that some browsers
//   normalise to "/" before navigating. The positive allowlist
//   (/^\/[A-Za-z0-9]/) closes all of these in one rule.
//
//   extractServerMessage(body) — pull the Express { error: { message } }
//   envelope safely out of an unknown JSON body, returning null when
//   the shape isn't there. Both auth surfaces talk to the same Express
//   error contract.
//
// SubmitResult is the uniform shape every submit helper returns. The
// {ok:true} | {ok:false; message} discriminated union form confused
// TypeScript's control-flow narrowing in the consuming component, so
// both branches carry the same keys.

export interface SubmitResult {
  ok: boolean;
  status: number;
  message: string;
}

export interface AuthSubmitOptions {
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
}

interface ServerErrorBody {
  error?: { code?: string; message?: string };
}

export function extractServerMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const err = (body as ServerErrorBody).error;
  if (!err || typeof err !== "object") return null;
  const msg = err.message;
  return typeof msg === "string" && msg.length > 0 ? msg : null;
}

// Restrict `from` to a same-origin absolute path. Allowlist is "/X..."
// where X is ASCII alphanumeric — chosen because every gated route
// (proxy.ts matcher: /admin, /library, /player) begins that way, as do
// /search /seasonal /welcome etc. Next.js URL-decodes searchParams
// before they reach this function (e.g. "%2F%2Fevil.com" arrives as
// "//evil.com"), so percent-encoded protocol-relative attacks are
// caught by the second-char rule too.
//
// Also reject the auth surfaces themselves ("/login", "/register") so
// a stale tab POSTing the page back to itself doesn't loop.
const SELF_LOOP_TARGETS = ["/login", "/register"] as const;

export function sanitizeFromParam(raw: string | string[] | undefined): string {
  const FALLBACK = "/";
  if (raw === undefined) return FALLBACK;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return FALLBACK;
  if (!/^\/[A-Za-z0-9]/.test(value)) return FALLBACK;
  for (const target of SELF_LOOP_TARGETS) {
    if (
      value === target ||
      value.startsWith(`${target}?`) ||
      value.startsWith(`${target}#`)
    ) {
      return FALLBACK;
    }
  }
  return value;
}

// Backend error.message → localized string, with two defenses:
//
//   1. Own-property check rejects inherited keys like "__proto__",
//      "constructor", "toString" — without this the Record<string,
//      string> cast on dict.errors would surface Function values for
//      those keys (the `typeof translated === "string"` guard would
//      then drop them silently, but the lookup is still semantically
//      wrong).
//   2. 200-char cap so a misbehaving backend (or a future error
//      surface that hasn't been audited) can't dump a wall of text
//      into the inline error region.
//
// dict.errors is the source-of-truth English→localized table from
// next-app/src/locales/{zh,en}.ts.
const MAX_ERROR_LENGTH = 200;

export function translateErrorMessage(
  message: string,
  dict: { errors: Record<string, string> },
): string {
  const map = dict.errors;
  const translated = Object.prototype.hasOwnProperty.call(map, message)
    ? map[message]
    : undefined;
  const out =
    typeof translated === "string" && translated.length > 0 ? translated : message;
  return out.slice(0, MAX_ERROR_LENGTH);
}

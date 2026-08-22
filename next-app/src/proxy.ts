import { NextResponse, type NextRequest } from "next/server";
import jwt from "jsonwebtoken";
import { isLang } from "@/lib/i18n/lang";
import {
  DEFAULT_LOCALE,
  localeForLang,
  localizePath,
  routerPath,
  splitLocale,
  type Locale,
} from "@/lib/i18n/locale";

// P7 + P6 + P9: the single Next 16 request interceptor.
//
// Two jobs, in order, on every request:
//
//   1. SESSION REFRESH (all routes) — the `session` access JWT lives only
//      ~15 min. RSC server renders (ContinueWatching, the Navbar login
//      state, subscribe buttons) fetch go-api server-side and have no way
//      to refresh on a 401 the way the client authFetch does, and Server
//      Components cannot set cookies. So when the access token is expired
//      but a long-lived `refreshToken` cookie is present, we refresh it
//      HERE — call go-api /api/auth/refresh, then hand the fresh cookies to
//      BOTH this request's RSC render (rewritten Cookie header) and the
//      browser (Set-Cookie). Without this, a logged-in user looks logged
//      out after 15 min on any navigation / language toggle.
//
//   2. AUTH GATE (/admin, /library, library-mode /player, /profile) — verify the (now
//      possibly refreshed) session against JWT_SECRET and redirect to
//      /login?from=<path> if absent/expired/tampered. /admin additionally
//      requires role "admin". Bare /player is a public local-file trial;
//      /player?seriesId=... stays gated because it opens a user's persisted
//      library. /profile (P11) is the user's own subscription list — auth-only.
//
// Runtime: Next 16 renamed the deprecated `middleware` convention to this
// `proxy.ts`. Proxy runs on the Node.js runtime (the `runtime` config is
// not allowed here), which is what we need — jsonwebtoken depends on Node
// crypto, and fetch()/getSetCookie() are available.
//
// go-api signs the access JWT with the same secret next-app verifies
// against (shared JWT_SECRET), so the gate's jwt.verify accepts go-api
// sessions and the refreshed session alike.

interface SessionPayload {
  userId?: string;
  username?: string;
  role?: string;
}

const GO_API_INTERNAL_URL =
  process.env.GO_API_INTERNAL_URL || "http://go-api:8080";

// Refresh slightly before the real expiry so a request that lands right on
// the boundary still renders logged-in.
const EXPIRY_SKEW_MS = 30_000;

export const config = {
  // Run site-wide so the refresh step covers every surface that renders
  // auth state, not just the gated routes. Excludes static assets + the
  // image optimizer so we don't fire on every .png/.css.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpe?g|gif|svg|ico|webp|avif|css|js|woff2?)$).*)",
  ],
};

// Takes the path WITHOUT its locale prefix. Passing a raw pathname here is
// the bug this signature exists to prevent: "/en/library" starts with
// neither "/library" nor anything else in the list, so an English visitor
// would have walked straight past the gate.
function isGated(path: string, searchParams: URLSearchParams): boolean {
  return (
    path.startsWith("/admin") ||
    path.startsWith("/library") ||
    (path.startsWith("/player") && searchParams.has("seriesId")) ||
    path.startsWith("/profile") ||
    path.startsWith("/settings")
  );
}

// Paths the locale step must not touch.
//
// The matcher above is intentionally left alone. It is broader than the
// locale step wants — it still catches /sitemap.xml, /robots.txt, the jassub
// .wasm bundles and /api/* — but narrowing it would also change which
// requests reach the refresh and auth steps, and this project has already
// had one production incident from moving that boundary (server-side refresh
// racing the client's authFetch across a two-slot refresh-token rotation,
// PR #45, reverted in #49). An i18n change is not the place to re-open it.
//
// So the guard lives here instead, and is about one thing: a request that is
// not a page must not be rewritten under a locale segment. Rewriting
// /sitemap.xml to /zh-Hans/sitemap.xml 404s the sitemap, which is the single
// URL this site most needs Google to keep fetching.
const NON_PAGE_PATH = /^\/api\/|^\/_next\/|\.[a-z0-9]+$/i;

function shouldLocalize(pathname: string): boolean {
  return !NON_PAGE_PATH.test(pathname);
}

/**
 * A 301 off the legacy `?lang=en` URLs onto the real English tree.
 *
 * Those URLs were advertised to Google as the English alternate for two and
 * a half months while the server ignored the parameter and served Chinese
 * (see lib/seo/alternates.ts). Now that /en actually exists, they get a
 * permanent redirect to it rather than being left as duplicate Chinese
 * pages. The parameter is dropped: it never meant anything and keeping it
 * would produce a second URL for every English page.
 *
 * Built from the origin rather than nextUrl.clone(), which carries the old
 * query string along — the same trap that once leaked `?id=…` onto /login.
 */
function redirectLegacyLangParam(
  req: NextRequest,
  path: string,
  locale: Locale,
): NextResponse {
  const url = new URL(req.nextUrl.origin);
  url.pathname = localizePath(path, locale);
  for (const [key, value] of req.nextUrl.searchParams) {
    if (key !== "lang") url.searchParams.append(key, value);
  }
  return NextResponse.redirect(url, 301);
}

// True if the session cookie is missing, unparseable, or expired (with
// skew). Uses jwt.decode (no signature check) — the real verification is
// go-api's during refresh and the gate's jwt.verify below.
function needsRefresh(token: string | undefined): boolean {
  if (!token) return true;
  const decoded = jwt.decode(token) as { exp?: number } | null;
  if (!decoded?.exp) return true;
  return decoded.exp * 1000 <= Date.now() + EXPIRY_SKEW_MS;
}

// Pull a cookie value out of an array of Set-Cookie header strings.
function valueFromSetCookies(
  setCookies: string[],
  name: string,
): string | undefined {
  for (const c of setCookies) {
    const eq = c.indexOf("=");
    if (eq !== -1 && c.slice(0, eq) === name) {
      const semi = c.indexOf(";", eq);
      return c.slice(eq + 1, semi === -1 ? undefined : semi);
    }
  }
  return undefined;
}

// Rebuild the incoming Cookie header with refreshed values overwritten in
// place (preserving every other cookie, e.g. `lang`).
function rebuildCookieHeader(
  original: string,
  updates: Record<string, string>,
): string {
  const parts = original ? original.split(/;\s*/).filter(Boolean) : [];
  const applied = new Set<string>();
  const out = parts.map((p) => {
    const eq = p.indexOf("=");
    const key = eq === -1 ? p : p.slice(0, eq);
    if (key in updates) {
      applied.add(key);
      return `${key}=${updates[key]}`;
    }
    return p;
  });
  for (const [k, v] of Object.entries(updates)) {
    if (!applied.has(k)) out.push(`${k}=${v}`);
  }
  return out.join("; ");
}

export async function proxy(req: NextRequest) {
  // --- 0. Resolve the locale. No side effects: this only decides which
  // locale the request addresses and what the path is inside it. The rewrite
  // that acts on it happens last, so the ORDER OF EFFECTS below is still
  // refresh-then-gate. Reversing those two logs out every user whose access
  // JWT has expired but whose refresh token is still good. ---
  const pathname = req.nextUrl.pathname;
  const localize = shouldLocalize(pathname);
  const { locale, path } = localize
    ? splitLocale(pathname)
    : { locale: DEFAULT_LOCALE as Locale, path: pathname };

  // Legacy ?lang= URLs move to the real locale tree, permanently.
  const legacyLang = localize ? req.nextUrl.searchParams.get("lang") : null;
  if (legacyLang && isLang(legacyLang)) {
    return redirectLegacyLangParam(req, path, localeForLang(legacyLang));
  }

  const session = req.cookies.get("session")?.value;
  const refreshToken = req.cookies.get("refreshToken")?.value;

  let effectiveSession = session;
  let setCookies: string[] | null = null;

  // --- 1. Refresh step (all routes) ---
  if (needsRefresh(session) && refreshToken) {
    try {
      const r = await fetch(`${GO_API_INTERNAL_URL}/api/auth/refresh`, {
        method: "POST",
        headers: { cookie: req.headers.get("cookie") ?? "" },
      });
      if (r.ok) {
        const cookies = r.headers.getSetCookie();
        if (cookies.length) {
          setCookies = cookies;
          effectiveSession =
            valueFromSetCookies(cookies, "session") ?? effectiveSession;
        }
      }
      // Non-ok (refreshToken truly expired/invalid): fall through. The gate
      // will bounce gated routes to /login; non-gated routes render as
      // logged-out, which is correct.
    } catch {
      // Transient go-api hiccup — never block the page; fall through with
      // the existing (stale) session.
    }
  }

  // --- 2. Auth gate (only gated routes) ---
  if (localize && isGated(path, req.nextUrl.searchParams)) {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      // Misconfig: fail closed.
      return new NextResponse(
        "Server misconfiguration: JWT_SECRET missing",
        { status: 500 },
      );
    }

    let decoded: SessionPayload | null = null;
    if (effectiveSession) {
      try {
        decoded = jwt.verify(effectiveSession, secret) as SessionPayload;
      } catch {
        decoded = null;
      }
    }

    if (!decoded) {
      // Expired/tampered and not refreshable — clear and bounce so the
      // browser stops replaying the bad cookie.
      const res = redirectToLogin(req, path, locale);
      res.cookies.delete("session");
      return res;
    }

    if (path.startsWith("/admin") && decoded.role !== "admin") {
      return new NextResponse("Forbidden", { status: 403 });
    }
  }

  // --- 3. Emit, rewriting into the router's locale segment.
  //
  // A REWRITE, never a redirect. Every indexed URL on this site is a bare
  // path; redirecting them under /zh-Hans/ would 301 the entire existing
  // index at once and hand Google a migration it did not ask for. It would
  // also break the Cloudflare cache rule, which matches on
  // starts_with(uri.path, "/anime/") and is not in this repository.
  //
  // The visitor keeps their URL. The router sees /[lang]/…, and Next keys
  // the ISR cache on the rewritten pathname — so /anime/21 and the
  // prerendered /zh-Hans/anime/21 are the same cache entry.
  //
  // Note what this does to an unknown first segment: splitLocale leaves it
  // in `path`, so /fr/anime/21 rewrites to /zh-Hans/fr/anime/21, which
  // matches no route and genuinely 404s. Same for /zh-Hans/anime/21 typed
  // directly — the default locale is not a public prefix, so it becomes
  // /zh-Hans/zh-Hans/anime/21. That is how a `[lang]` segment is stopped
  // from swallowing every junk URL into a soft 404, and it also makes the
  // double-prefix guard fall out for free rather than needing its own check.
  const reqHeaders = new Headers(req.headers);

  if (setCookies) {
    const updates: Record<string, string> = {};
    const newSession = valueFromSetCookies(setCookies, "session");
    const newRefresh = valueFromSetCookies(setCookies, "refreshToken");
    if (newSession) updates.session = newSession;
    if (newRefresh) updates.refreshToken = newRefresh;

    reqHeaders.set(
      "cookie",
      rebuildCookieHeader(req.headers.get("cookie") ?? "", updates),
    );
  }

  const target = localize ? routerPath(path, locale) : null;
  const res =
    target && target !== pathname
      ? NextResponse.rewrite(rewriteUrl(req, target), {
          request: { headers: reqHeaders },
        })
      : NextResponse.next({ request: { headers: reqHeaders } });

  if (setCookies) {
    for (const c of setCookies) res.headers.append("set-cookie", c);
  }
  return res;
}

/**
 * The rewrite target, built from the origin so no part of the incoming URL
 * comes along uninspected. The query string is copied deliberately —
 * /search?q=x has to stay /search?q=x for the page to see its params.
 */
function rewriteUrl(req: NextRequest, pathname: string): URL {
  const url = new URL(req.nextUrl.origin);
  url.pathname = pathname;
  url.search = req.nextUrl.search;
  return url;
}

function redirectToLogin(req: NextRequest, path: string, locale: Locale) {
  // Build /login from scratch so the source query string doesn't leak onto
  // the top-level /login URL; the original path+query rides in `from`.
  //
  // Both halves are localized. An English visitor bounced to a bare /login
  // would land in Simplified Chinese, and a `from` without the prefix would
  // then drop them back into Simplified after a successful sign-in — the
  // locale would be lost at exactly the moment the visitor is least able to
  // tell why.
  const url = new URL(req.nextUrl.origin);
  url.pathname = localizePath("/login", locale);
  url.searchParams.set("from", localizePath(path, locale) + req.nextUrl.search);
  return NextResponse.redirect(url);
}

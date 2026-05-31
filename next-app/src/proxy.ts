import { NextResponse, type NextRequest } from "next/server";
import jwt from "jsonwebtoken";

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
//   2. AUTH GATE (/admin, /library, /player, /profile) — verify the (now
//      possibly refreshed) session against JWT_SECRET and redirect to
//      /login?from=<path> if absent/expired/tampered. /admin additionally
//      requires role "admin". Library + Player ride the same gate because
//      Dexie + File System Access + jassub live behind auth in the legacy
//      SPA, and the P6 reauth E2E needs a server-side redirect. /profile
//      (P11) is the user's own subscription list — auth-only.
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

function isGated(path: string): boolean {
  return (
    path.startsWith("/admin") ||
    path.startsWith("/library") ||
    path.startsWith("/player") ||
    path.startsWith("/profile")
  );
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
  if (isGated(req.nextUrl.pathname)) {
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
      const res = redirectToLogin(req);
      res.cookies.delete("session");
      return res;
    }

    if (
      req.nextUrl.pathname.startsWith("/admin") &&
      decoded.role !== "admin"
    ) {
      return new NextResponse("Forbidden", { status: 403 });
    }
  }

  // --- 3. Emit. Forward x-pathname on every request so RSC (layout.tsx
  // generateMetadata) can emit a self-referential canonical + hreflang per
  // route — a Server Component can't otherwise read the request path. The
  // path carries NO query string, so /search?q=… canonicalises to /search
  // (avoids indexing infinite query variants). (#41) ---
  const reqHeaders = new Headers(req.headers);
  reqHeaders.set("x-pathname", req.nextUrl.pathname);

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

    const res = NextResponse.next({ request: { headers: reqHeaders } });
    for (const c of setCookies) res.headers.append("set-cookie", c);
    return res;
  }

  return NextResponse.next({ request: { headers: reqHeaders } });
}

function redirectToLogin(req: NextRequest) {
  // Build /login from scratch so the source query string doesn't leak onto
  // the top-level /login URL; the original path+query rides in `from`.
  const url = new URL(req.nextUrl.origin);
  url.pathname = "/login";
  url.searchParams.set("from", req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.redirect(url);
}

import { NextResponse, type NextRequest } from "next/server";
import jwt from "jsonwebtoken";

// P7: server-side gate for /admin/*.
//
// Reads the `session` cookie (issued by Express /api/auth/login since
// commit cc073f9), verifies the JWT against JWT_SECRET, and 403s if
// the decoded role isn't "admin". Unauthenticated visitors get a 302
// to /login?from=<originally-requested-path> so post-login they land
// where they intended.
//
// Notes:
// - Next 16 deprecated the `middleware` file convention in favour of
//   this `proxy.ts`. Default runtime is Node.js (the `runtime` config
//   option is not allowed in proxy files), which is what we need —
//   jsonwebtoken depends on Node crypto.
// - Server Actions invoked from /admin pages travel as POSTs to the
//   page route, so this matcher catches them too. We still re-check
//   the role inside each mutation in `app/admin/_actions/*` as a
//   belt-and-suspenders measure (proxy matcher changes are easy to
//   silently break).

interface SessionPayload {
  userId?: string;
  username?: string;
  role?: string;
}

export const config = {
  matcher: "/admin/:path*",
};

export function proxy(req: NextRequest) {
  const token = req.cookies.get("session")?.value;
  if (!token) return redirectToLogin(req);

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    // Misconfig: fail closed. Better a 500 than letting unauthenticated
    // traffic through because the verification step silently succeeded.
    return new NextResponse("Server misconfiguration: JWT_SECRET missing", {
      status: 500,
    });
  }

  let decoded: SessionPayload;
  try {
    decoded = jwt.verify(token, secret) as SessionPayload;
  } catch {
    // Expired or tampered token — clear it and bounce to login. Without
    // the clear, browsers keep replaying the bad cookie and a confused
    // user sees an infinite redirect.
    const res = redirectToLogin(req);
    res.cookies.delete("session");
    return res;
  }

  if (decoded.role !== "admin") {
    return new NextResponse("Forbidden", { status: 403 });
  }

  return NextResponse.next();
}

function redirectToLogin(req: NextRequest) {
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("from", req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.redirect(url);
}

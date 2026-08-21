import { NextResponse } from "next/server";

/**
 * The running deployment's build id, for tabs that were opened before it.
 *
 * ## Why this path
 *
 * `.json`, and not under `/api/`, and both halves are load-bearing.
 *
 * In production nginx sends `/api/` to **go-api**, not to next-app (see
 * `location /api/` in nginx/default.p9.conf, which deploy.sh installs as
 * default.conf). Anything this app serves under /api/ is unreachable there —
 * `app/api/healthz/route.ts` already is, silently. The catch-all
 * `location /` is what reaches next-app.
 *
 * The extension is what keeps proxy.ts's locale step off it: `NON_PAGE_PATH`
 * excludes anything ending in a file extension, so `/version.json` is served
 * as itself. `/version` would be rewritten to `/zh-Hans/version`, which is not
 * a route, and this would 404 in every environment including this one.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(
    { buildId: process.env.NEXT_PUBLIC_BUILD_ID ?? null },
    {
      status: 200,
      headers: {
        // A cached copy of this answer is a wrong answer by definition — the
        // one thing it reports is which deployment is live right now. Belt and
        // braces: `no-store` for anything that honours it, and CDN-Cache-Control
        // for Cloudflare specifically, since .json is not one of the extensions
        // it caches by default but that default is a setting, not a promise.
        "Cache-Control": "no-store, must-revalidate",
        "CDN-Cache-Control": "no-store",
      },
    },
  );
}

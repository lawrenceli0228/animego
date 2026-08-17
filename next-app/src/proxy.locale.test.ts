import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import jwt from "jsonwebtoken";
import { NextRequest } from "next/server";
import { mockFetch } from "@/lib/test-utils/fetchMock";
import { proxy } from "./proxy";

// The locale step of the proxy, tested at the level that matters: what the
// router is asked to render, and what status the visitor gets.
//
// The single most expensive mistake this file exists to prevent is a bare
// path turning into a redirect. Every indexed URL on this site is a bare
// path, the whole acquisition channel is organic search, and a 301 sweep
// across the entire index is not something you notice for weeks — traffic
// just erodes. So `/anime/21` returning anything other than a rewrite is a
// failed test, not a design discussion.

const SECRET = "test-secret-for-proxy-locale";
let originalSecret: string | undefined;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  originalSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = SECRET;
  globalThis.fetch = mockFetch(async () => {
    throw new Error("unexpected fetch in proxy locale test");
  });
});

afterEach(() => {
  if (originalSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalSecret;
  globalThis.fetch = originalFetch;
});

function request(url: string, cookies: Record<string, string> = {}) {
  const headers = new Headers();
  const pairs = Object.entries(cookies).map(([k, v]) => `${k}=${v}`);
  if (pairs.length) headers.set("Cookie", pairs.join("; "));
  return new NextRequest(new URL(`https://animegoclub.com${url}`), { headers });
}

/** The path the router is asked to render, or null when nothing was rewritten. */
function rewrittenTo(res: Response): string | null {
  const header = res.headers.get("x-middleware-rewrite");
  return header ? new URL(header).pathname + new URL(header).search : null;
}

describe("bare paths keep their URL", () => {
  test("/anime/21 is rewritten, never redirected", async () => {
    const res = await proxy(request("/anime/21"));
    // 200 with a rewrite header. A 301/307/308 here would move the index.
    expect(res.status).toBe(200);
    expect(rewrittenTo(res)).toBe("/zh-Hans/anime/21");
  });

  test("the site root maps to the default locale segment", async () => {
    expect(rewrittenTo(await proxy(request("/")))).toBe("/zh-Hans");
  });

  test("a query string survives the rewrite", async () => {
    // /search reads its params from searchParams; losing them renders the
    // empty browse page while the address bar still shows a query.
    expect(rewrittenTo(await proxy(request("/search?q=frieren&page=2")))).toBe(
      "/zh-Hans/search?q=frieren&page=2",
    );
  });

  test("no bare path in the sitemap redirects", async () => {
    // Every path app/sitemap.ts publishes. Sampled rather than imported so
    // this stays a black-box assertion about the proxy.
    for (const path of ["/", "/seasonal/spring/2026", "/calendar", "/faq", "/terms", "/privacy", "/copyright"]) {
      const res = await proxy(request(path));
      expect({ path, status: res.status }).toEqual({ path, status: 200 });
    }
  });
});

describe("published locale prefixes pass through untouched", () => {
  test("/en is left alone", async () => {
    expect(rewrittenTo(await proxy(request("/en")))).toBeNull();
  });

  test("/en/faq is already the router path", async () => {
    expect(rewrittenTo(await proxy(request("/en/faq")))).toBeNull();
  });
});

describe("unknown first segments fall through to a real 404", () => {
  // A `[lang]` segment matches ANYTHING. Without this behaviour every junk
  // URL on the internet would render the homepage with a 200 — a soft 404 on
  // an unbounded surface, on a site crawlers have already swept for 3,278
  // ids.
  test("an unknown locale stays in the path", async () => {
    expect(rewrittenTo(await proxy(request("/fr/anime/21")))).toBe("/zh-Hans/fr/anime/21");
  });

  test("the default locale is not publicly addressable", async () => {
    // Otherwise every page would have a second, duplicate URL.
    expect(rewrittenTo(await proxy(request("/zh-Hans/anime/21")))).toBe(
      "/zh-Hans/zh-Hans/anime/21",
    );
  });

  test("a doubled public prefix does not resolve", async () => {
    // splitLocale strips one prefix only, so /en/en/faq asks the router for
    // /en/en/faq — lang "en", then "/en/faq", which matches no route. The
    // double-prefix guard is a property of the split, not a special case.
    expect(rewrittenTo(await proxy(request("/en/en/faq")))).toBeNull();
  });

  test("junk paths are not absorbed by the locale segment", async () => {
    expect(rewrittenTo(await proxy(request("/wp-admin")))).toBe("/zh-Hans/wp-admin");
  });
});

describe("non-page requests are never localized", () => {
  // Rewriting /sitemap.xml to /zh-Hans/sitemap.xml 404s the one URL this
  // site most needs Google to keep fetching.
  test.each([["/sitemap.xml"], ["/robots.txt"], ["/api/healthz"], ["/jassub/wasm/worker.bundle.js"]])(
    "%s is passed straight through",
    async (path) => {
      expect(rewrittenTo(await proxy(request(path)))).toBeNull();
    },
  );
});

describe("legacy ?lang= URLs move to the real tree", () => {
  test("?lang=en becomes a permanent redirect to /en", async () => {
    const res = await proxy(request("/faq?lang=en"));
    // 301, not 302: these were advertised to Google as an alternate for two
    // and a half months and should leave the index rather than linger.
    expect(res.status).toBe(301);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/en/faq");
    expect(location.search).toBe("");
  });

  test("the root form redirects to /en", async () => {
    const location = new URL((await proxy(request("/?lang=en"))).headers.get("location")!);
    expect(location.pathname).toBe("/en");
  });

  test("?lang=zh redirects to the bare tree", async () => {
    const location = new URL((await proxy(request("/faq?lang=zh"))).headers.get("location")!);
    expect(location.pathname).toBe("/faq");
    expect(location.search).toBe("");
  });

  test("other query params survive, the lang param does not", async () => {
    const location = new URL(
      (await proxy(request("/search?q=frieren&page=2&lang=en"))).headers.get("location")!,
    );
    expect(location.pathname).toBe("/en/search");
    expect(location.searchParams.get("q")).toBe("frieren");
    expect(location.searchParams.get("page")).toBe("2");
    expect(location.searchParams.get("lang")).toBeNull();
  });

  test("an unrecognised lang value is not redirected", async () => {
    // Only values that name a real dictionary get a redirect; anything else
    // would be inventing a URL for a locale that does not exist.
    const res = await proxy(request("/faq?lang=fr"));
    expect(res.status).toBe(200);
  });
});

describe("the auth gate is locale-aware", () => {
  const session = (role = "user") =>
    jwt.sign({ userId: "u1", username: "alice", role }, SECRET, { expiresIn: "15m" });

  test("a prefixed gated route is still gated", async () => {
    // isGated tests the un-prefixed path. Before that, "/en/library" started
    // with none of the gated prefixes and walked straight through.
    const res = await proxy(request("/en/library"));
    expect(res.status).toBe(307);
  });

  test("the login bounce keeps the visitor in their locale", async () => {
    const location = new URL((await proxy(request("/en/library"))).headers.get("location")!);
    expect(location.pathname).toBe("/en/login");
    // `from` too: a bare from would drop them into Simplified after signing in.
    expect(location.searchParams.get("from")).toBe("/en/library");
  });

  test("the bare tree is unchanged", async () => {
    const location = new URL((await proxy(request("/library"))).headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("from")).toBe("/library");
  });

  test("/en/admin still requires the admin role", async () => {
    const res = await proxy(request("/en/admin", { session: session("user") }));
    expect(res.status).toBe(403);
  });

  test("/en/admin admits an admin, and rewrites", async () => {
    const res = await proxy(request("/en/admin", { session: session("admin") }));
    expect(res.status).toBe(200);
  });

  test("a signed-in user reaches a prefixed gated route", async () => {
    const res = await proxy(request("/en/library", { session: session() }));
    expect(res.status).toBe(200);
  });
});

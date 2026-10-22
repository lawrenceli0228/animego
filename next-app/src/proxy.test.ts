import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mockFetch } from "@/lib/test-utils/fetchMock";
import jwt from "jsonwebtoken";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

const SECRET = "test-secret-for-proxy";
let originalSecret: string | undefined;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  originalSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = SECRET;
  // Default: fetch should not fire unless a test opts in.
  // If refresh branch fires unexpectedly, the test will blow up rather than
  // silently succeed — which is the right behaviour for deterministic tests.
  globalThis.fetch = mockFetch(async () => {
    throw new Error("unexpected fetch in proxy test — mock fetch explicitly");
  });
});

afterEach(() => {
  if (originalSecret === undefined) {
    delete process.env.JWT_SECRET;
  } else {
    process.env.JWT_SECRET = originalSecret;
  }
  globalThis.fetch = originalFetch;
});

function buildRequest(path: string, cookies: Record<string, string> = {}) {
  const url = new URL(`https://animegoclub.com${path}`);
  const headers = new Headers();
  const cookiePairs = Object.entries(cookies).map(([k, v]) => `${k}=${v}`);
  if (cookiePairs.length) headers.set("Cookie", cookiePairs.join("; "));
  return new NextRequest(url, { headers });
}

describe("proxy /admin gate", () => {
  test("redirects to /login when session cookie is missing", async () => {
    const res = await proxy(buildRequest("/admin/enrichment"));
    expect(res.status).toBe(307); // NextResponse.redirect default
    const location = res.headers.get("location");
    expect(location).not.toBeNull();
    const loc = new URL(location!);
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("from")).toBe("/admin/enrichment");
  });

  test("preserves search params in `from` redirect", async () => {
    const res = await proxy(buildRequest("/admin/users?page=2&q=alice"));
    const location = res.headers.get("location");
    const loc = new URL(location!);
    expect(loc.searchParams.get("from")).toBe("/admin/users?page=2&q=alice");
  });

  test("does not leak original query params to the /login top-level URL", async () => {
    // Regression: ISSUE-002 — the cloned URL inherited the source request's
    // query string, so /player/episode?id=test redirected to
    // /login?id=test&from=%2Fplayer%2Fepisode%3Fid%3Dtest. The `id` belongs
    // inside the `from` round-trip, not as a top-level /login param.
    const res = await proxy(buildRequest("/admin/users?page=2&q=alice"));
    const loc = new URL(res.headers.get("location")!);
    const paramKeys = Array.from(loc.searchParams.keys());
    expect(paramKeys).toEqual(["from"]);
  });

  test("returns 500 when JWT_SECRET is missing", async () => {
    delete process.env.JWT_SECRET;
    const token = jwt.sign({ role: "admin" }, "anything-since-secret-is-gone");
    const res = await proxy(buildRequest("/admin", { session: token }));
    expect(res.status).toBe(500);
  });

  test("redirects + clears cookie on tampered token", async () => {
    const res = await proxy(buildRequest("/admin", { session: "not.a.real.jwt" }));
    expect(res.status).toBe(307);
    const location = res.headers.get("location");
    expect(new URL(location!).pathname).toBe("/login");
    // Set-Cookie header should include a `session=` clear directive
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain("session=");
    // Cleared cookies carry a past Max-Age / Expires
    expect(setCookie?.toLowerCase()).toMatch(/max-age=0|expires=/);
  });

  test("redirects on expired token", async () => {
    const token = jwt.sign({ role: "admin" }, SECRET, { expiresIn: "-1h" });
    const res = await proxy(buildRequest("/admin", { session: token }));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
  });

  test("returns 403 when role is not admin", async () => {
    const token = jwt.sign(
      { userId: "u1", username: "alice", role: "user" },
      SECRET,
    );
    const res = await proxy(buildRequest("/admin", { session: token }));
    expect(res.status).toBe(403);
  });

  test("returns 403 when role claim is missing", async () => {
    const token = jwt.sign({ userId: "u1", username: "alice" }, SECRET);
    const res = await proxy(buildRequest("/admin", { session: token }));
    expect(res.status).toBe(403);
  });

  test("passes through when role is admin", async () => {
    const token = jwt.sign(
      { userId: "u1", username: "alice", role: "admin" },
      SECRET,
    );
    const res = await proxy(buildRequest("/admin/enrichment", { session: token }));
    // NextResponse.next() returns status 200 with the rewrite header set
    expect(res.status).toBe(200);
    // No location header — we passed through, not redirected
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("proxy /library gate + public /player trial", () => {
  test("/library no session → /login redirect with from preserved", async () => {
    const res = await proxy(buildRequest("/library"));
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("from")).toBe("/library");
  });

  test("bare /player is public for the local-file trial", async () => {
    const res = await proxy(buildRequest("/player"));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  test("/player library mode still redirects with from preserved", async () => {
    const res = await proxy(buildRequest("/player?seriesId=abc&fileId=42"));
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("from")).toBe(
      "/player?seriesId=abc&fileId=42",
    );
  });

  test("/library passes through with a non-admin valid session", async () => {
    const token = jwt.sign(
      { userId: "u1", username: "alice", role: "user" },
      SECRET,
    );
    const res = await proxy(buildRequest("/library", { session: token }));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  test("signed-in /player library mode passes with no role claim", async () => {
    const token = jwt.sign({ userId: "u1", username: "alice" }, SECRET);
    const res = await proxy(
      buildRequest("/player?seriesId=abc", { session: token }),
    );
    expect(res.status).toBe(200);
  });

  test("/library/123 nested path still gated", async () => {
    const res = await proxy(buildRequest("/library/abc123"));
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("from")).toBe("/library/abc123");
  });

  test("/admin still requires admin role even with the new shared matcher", async () => {
    const token = jwt.sign(
      { userId: "u1", username: "alice", role: "user" },
      SECRET,
    );
    const res = await proxy(buildRequest("/admin/enrichment", { session: token }));
    expect(res.status).toBe(403);
  });
});

describe("proxy /watching gate (全部在追)", () => {
  test("no session → /login with from preserved, like /profile", async () => {
    const res = await proxy(buildRequest("/watching"));
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("from")).toBe("/watching");
  });

  test("a signed-in reader passes through", async () => {
    const token = jwt.sign({ userId: "u1", username: "alice", role: "user" }, SECRET);
    const res = await proxy(buildRequest("/watching", { session: token }));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  test("an expired session is bounced and cleared", async () => {
    const token = jwt.sign({ userId: "u1" }, SECRET, { expiresIn: "-1h" });
    const res = await proxy(buildRequest("/watching", { session: token }));
    expect(res.status).toBe(307);
    expect(res.headers.get("set-cookie")).toContain("session=");
  });

  test("only the /watching segment is gated, not every path that starts with the word", async () => {
    // Not a route today; the point is that the gate matches a segment, not a prefix.
    const res = await proxy(buildRequest("/watchinglist"));
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("proxy session-refresh step (needsRefresh + refreshToken present)", () => {
  // Build a fresh session the go-api "refresh" endpoint would return.
  function freshSession(role = "user") {
    return jwt.sign({ userId: "u1", username: "alice", role }, SECRET, {
      expiresIn: "15m",
    });
  }

  test("when session is missing and refreshToken is present, calls go-api refresh and forwards cookies", async () => {
    const newSession = freshSession();
    const newRefreshToken = "new-refresh-token-value";
    globalThis.fetch = mockFetch(async () =>
      new Response(null, {
        status: 200,
        headers: {
          "set-cookie": [
            `session=${newSession}; Path=/; HttpOnly`,
            `refreshToken=${newRefreshToken}; Path=/; HttpOnly`,
          ].join(", "),
        },
      }),
    );

    const res = await proxy(
      buildRequest("/", { refreshToken: "old-refresh-token" }),
    );
    // Non-gated route: passes through
    expect(res.status).toBe(200);
    // The refreshed cookies are forwarded to the browser
    const setCookieHeader = res.headers.get("set-cookie");
    expect(setCookieHeader).toContain("session=");
  });

  test("when refresh succeeds the refreshed session is used for gate check (admin passes)", async () => {
    const adminSession = freshSession("admin");
    globalThis.fetch = mockFetch(async () =>
      new Response(null, {
        status: 200,
        headers: {
          "set-cookie": `session=${adminSession}; Path=/; HttpOnly`,
        },
      }),
    );

    const res = await proxy(
      buildRequest("/admin/enrichment", { refreshToken: "old-rt" }),
    );
    // The refreshed token has role=admin so the gate passes
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  test("when refresh returns non-ok, falls through to gate which bounces gated route", async () => {
    globalThis.fetch = mockFetch(async () =>
      new Response("Unauthorized", { status: 401 }),
    );

    const res = await proxy(
      buildRequest("/admin/enrichment", { refreshToken: "expired-rt" }),
    );
    // No effective session after failed refresh → gate redirects
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
  });

  test("when fetch throws (transient network error), falls through and gate bounces gated route", async () => {
    globalThis.fetch = mockFetch(async () => {
      throw new Error("network error");
    });

    const res = await proxy(
      buildRequest("/library", { refreshToken: "some-rt" }),
    );
    // No effective session after transient failure → gate redirects
    expect(res.status).toBe(307);
  });

  test("non-gated route passes through even after failed refresh (renders as logged-out)", async () => {
    globalThis.fetch = mockFetch(async () =>
      new Response("Unauthorized", { status: 401 }),
    );

    const res = await proxy(
      buildRequest("/", { refreshToken: "expired-rt" }),
    );
    // Non-gated: still passes through even without session
    expect(res.status).toBe(200);
  });

  test("when request already has an expired session cookie, rebuildCookieHeader overwrites it with the refreshed value", async () => {
    // This exercises the rebuildCookieHeader branch that updates an
    // existing key in the Cookie header (lines 104-105 in proxy.ts).
    const expiredSession = jwt.sign({ userId: "u1" }, SECRET, {
      expiresIn: "-1h",
    });
    const newSession = freshSession("user");

    globalThis.fetch = mockFetch(async () =>
      new Response(null, {
        status: 200,
        headers: {
          "set-cookie": `session=${newSession}; Path=/; HttpOnly`,
        },
      }),
    );

    const res = await proxy(
      buildRequest("/", {
        session: expiredSession,
        refreshToken: "some-refresh-token",
        lang: "zh",
      }),
    );
    // Passes through (non-gated) with refreshed cookies forwarded
    expect(res.status).toBe(200);
    const setCookieHeader = res.headers.get("set-cookie");
    expect(setCookieHeader).toContain(`session=${newSession}`);
  });
});

// A device signed out from another device's settings page (or by logout, or
// a password change) still holds an access token that verifies for up to 15
// minutes. The gate's jwt.verify cannot see that; go-api can.
describe("proxy: a session that has ended", () => {
  const AUTH_COOKIES = ["auth_hint", "refreshToken", "session"];

  function sessionFor(extra: Record<string, unknown> = {}) {
    return jwt.sign({ userId: "u1", sid: "s-1", username: "alice", ...extra }, SECRET, {
      expiresIn: "15m",
    });
  }

  function clearedCookies(res: Response): string[] {
    return res.headers
      .getSetCookie()
      .filter((c) => /Expires=Thu, 01 Jan 1970|Max-Age=0/.test(c))
      .map((c) => c.slice(0, c.indexOf("=")))
      .sort();
  }

  // go-api, answering /api/auth/me and /api/auth/refresh as told. Anything
  // else is a bug in the proxy, not a page that should go through.
  function goApi(answers: { me?: number; refresh?: number | "rotates" }) {
    return mockFetch(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/auth/me")) {
        return new Response("{}", { status: answers.me ?? 200 });
      }
      if (url.endsWith("/api/auth/refresh")) {
        if (answers.refresh === "rotates") {
          return new Response(null, {
            status: 200,
            headers: { "set-cookie": `session=${sessionFor()}; Path=/; HttpOnly` },
          });
        }
        return new Response("{}", { status: answers.refresh ?? 500 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
  }

  function calledPaths(spy: ReturnType<typeof goApi>): string[] {
    return spy.mock.calls.map((c) => new URL(String(c[0])).pathname);
  }

  test("a personal page whose session has ended sends the device to /login and clears every auth cookie", async () => {
    const spy = goApi({ me: 401, refresh: 401 });
    globalThis.fetch = spy;

    const res = await proxy(
      buildRequest("/settings", { session: sessionFor(), refreshToken: "rt", auth_hint: "1" }),
    );

    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("from")).toBe("/settings");
    expect(clearedCookies(res)).toEqual(AUTH_COOKIES);
    // the refresh token had the last word
    expect(calledPaths(spy)).toEqual(["/api/auth/me", "/api/auth/refresh"]);
  });

  test("without a refresh cookie, a refused access token is the end of it", async () => {
    const spy = goApi({ me: 401 });
    globalThis.fetch = spy;

    const res = await proxy(buildRequest("/library", { session: sessionFor() }));

    expect(res.status).toBe(307);
    expect(clearedCookies(res)).toEqual(AUTH_COOKIES);
    expect(calledPaths(spy)).toEqual(["/api/auth/me"]);
  });

  // A JWT_SECRET rotation, or the two services briefly disagreeing during a
  // deploy: go-api cannot verify the access token, yet the session is fine.
  test("an access token go-api refuses but whose session refreshes keeps the reader signed in", async () => {
    globalThis.fetch = goApi({ me: 401, refresh: "rotates" });

    const res = await proxy(buildRequest("/settings", { session: sessionFor(), refreshToken: "rt" }));

    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(clearedCookies(res)).toEqual([]);
    expect(res.headers.get("set-cookie")).toContain("session=");
  });

  test("a refresh that fails on go-api's side is not a verdict: the page goes through", async () => {
    globalThis.fetch = goApi({ me: 401, refresh: 503 });

    const res = await proxy(buildRequest("/settings", { session: sessionFor(), refreshToken: "rt" }));

    expect(res.status).toBe(200);
    expect(clearedCookies(res)).toEqual([]);
  });

  test("asks with the device's own access token and the reader's address, never a shared one", async () => {
    const token = sessionFor();
    const spy = goApi({ me: 200 });
    globalThis.fetch = spy;
    const headers = new Headers({
      Cookie: `session=${token}; refreshToken=rt`,
      "x-real-ip": "203.0.113.7",
      "x-forwarded-for": "203.0.113.7",
    });

    const res = await proxy(new NextRequest(new URL("https://animegoclub.com/library"), { headers }));

    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    const sent = new Headers(spy.mock.calls[0][1]?.headers);
    expect(sent.get("authorization")).toBe(`Bearer ${token}`);
    expect(sent.get("x-real-ip")).toBe("203.0.113.7");
    expect(sent.get("cookie")).toBeNull();
  });

  test("a live session passes the gate untouched, after one lookup", async () => {
    const spy = goApi({ me: 200 });
    globalThis.fetch = spy;

    const res = await proxy(buildRequest("/watching", { session: sessionFor() }));

    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(clearedCookies(res)).toEqual([]);
    expect(calledPaths(spy)).toEqual(["/api/auth/me"]);
  });

  test("go-api unreachable or failing is not a verdict: the page goes through", async () => {
    for (const fetchImpl of [
      mockFetch(async () => {
        throw new Error("connect ECONNREFUSED");
      }),
      mockFetch(async () => new Response("{}", { status: 500 })),
      mockFetch(async () => new Response("{}", { status: 429 })),
    ]) {
      globalThis.fetch = fetchImpl;

      const res = await proxy(buildRequest("/profile", { session: sessionFor() }));

      expect(res.status).toBe(200);
      expect(clearedCookies(res)).toEqual([]);
    }
  });

  test("a go-api that does not answer holds the page for at most the check's timeout", async () => {
    globalThis.fetch = mockFetch(
      (_input, init) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );

    const started = Date.now();
    const res = await proxy(buildRequest("/settings", { session: sessionFor() }));

    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  test("the admin role check still applies to a live session", async () => {
    const spy = goApi({ me: 200 });
    globalThis.fetch = spy;

    const res = await proxy(buildRequest("/admin", { session: sessionFor() }));

    expect(res.status).toBe(403);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("an English reader is sent to the English sign-in page", async () => {
    globalThis.fetch = goApi({ me: 401, refresh: 401 });

    const res = await proxy(buildRequest("/en/settings", { session: sessionFor(), refreshToken: "rt" }));

    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/en/login");
    expect(loc.searchParams.get("from")).toBe("/en/settings");
  });

  test("a client-side navigation (an RSC request) is checked like a page load", async () => {
    const spy = goApi({ me: 401, refresh: 401 });
    globalThis.fetch = spy;
    const headers = new Headers({ Cookie: `session=${sessionFor()}; refreshToken=rt`, rsc: "1" });

    const res = await proxy(new NextRequest(new URL("https://animegoclub.com/settings"), { headers }));

    expect(res.status).toBe(307);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test("tokens minted before they named a session, and public pages, are not looked up", async () => {
    const spy = mockFetch(async () => new Response("{}", { status: 401 }));
    globalThis.fetch = spy;
    const legacy = jwt.sign({ userId: "u1", username: "alice" }, SECRET, { expiresIn: "15m" });

    expect((await proxy(buildRequest("/settings", { session: legacy }))).status).toBe(200);
    expect((await proxy(buildRequest("/", { session: sessionFor() }))).status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
  });

  test("prefetches are not looked up: a page prefetches every gated link in view, and the navigation that follows is checked", async () => {
    const spy = mockFetch(async () => new Response("{}", { status: 401 }));
    globalThis.fetch = spy;
    const token = sessionFor();

    for (const header of ["next-router-prefetch", "next-router-segment-prefetch"]) {
      const headers = new Headers({ Cookie: `session=${token}`, [header]: "1" });
      const res = await proxy(new NextRequest(new URL("https://animegoclub.com/library"), { headers }));
      expect(res.status).toBe(200);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  test("a session refreshed in this same request is not looked up again", async () => {
    const spy = goApi({ refresh: "rotates" });
    globalThis.fetch = spy;

    const res = await proxy(buildRequest("/settings", { refreshToken: "rt" }));

    expect(res.status).toBe(200);
    expect(calledPaths(spy)).toEqual(["/api/auth/refresh"]);
  });

  // The sign-in pages send a reader holding a valid-looking session away
  // (login/page.tsx). A device signed out elsewhere must get the form.
  test("the sign-in page shows its form to a device whose session has ended", async () => {
    globalThis.fetch = goApi({ me: 401, refresh: 401 });

    const res = await proxy(
      buildRequest("/login", { session: sessionFor(), refreshToken: "rt", auth_hint: "1", lang: "zh" }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(clearedCookies(res)).toEqual(AUTH_COOKIES);
    const forwarded = res.headers.get("x-middleware-request-cookie") ?? "";
    expect(forwarded).not.toContain("session=");
    expect(forwarded).not.toContain("refreshToken=");
    expect(forwarded).toContain("lang=zh");
  });

  test("the sign-in page leaves a live session alone (the page sends the reader on)", async () => {
    const spy = goApi({ me: 200 });
    globalThis.fetch = spy;

    const res = await proxy(buildRequest("/register", { session: sessionFor(), refreshToken: "rt" }));

    expect(res.status).toBe(200);
    expect(clearedCookies(res)).toEqual([]);
    expect(calledPaths(spy)).toEqual(["/api/auth/me"]);
  });

  test("a non-admin turned away from /admin still gets the cookies their refresh rotated", async () => {
    globalThis.fetch = goApi({ refresh: "rotates" });

    const res = await proxy(buildRequest("/admin", { refreshToken: "rt" }));

    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toContain("session=");
  });
});

describe("proxy: a refresh go-api refuses for good", () => {
  function clearedCookies(res: Response): string[] {
    return res.headers
      .getSetCookie()
      .filter((c) => /Expires=Thu, 01 Jan 1970|Max-Age=0/.test(c))
      .map((c) => c.slice(0, c.indexOf("=")))
      .sort();
  }

  test("clears every auth cookie, on a public page too, so the browser stops retrying it", async () => {
    globalThis.fetch = mockFetch(async () => new Response("{}", { status: 401 }));

    const res = await proxy(buildRequest("/", { refreshToken: "dead-rt", auth_hint: "1", lang: "zh" }));

    expect(res.status).toBe(200);
    expect(clearedCookies(res)).toEqual(["auth_hint", "refreshToken", "session"]);
    // and this request renders signed out: the page never sees the dead cookies
    const forwarded = res.headers.get("x-middleware-request-cookie") ?? "";
    expect(forwarded).not.toContain("refreshToken=");
    expect(forwarded).not.toContain("auth_hint=");
    expect(forwarded).toContain("lang=zh");
  });

  test("a gated page bounces to /login with every auth cookie cleared", async () => {
    globalThis.fetch = mockFetch(async () => new Response("{}", { status: 401 }));

    const res = await proxy(buildRequest("/settings", { refreshToken: "dead-rt", auth_hint: "1" }));

    expect(res.status).toBe(307);
    expect(clearedCookies(res)).toEqual(["auth_hint", "refreshToken", "session"]);
  });

  test("a refresh that failed on go-api's side keeps the cookies for the next try", async () => {
    for (const fetchImpl of [
      mockFetch(async () => new Response("{}", { status: 500 })),
      mockFetch(async () => {
        throw new Error("network error");
      }),
    ]) {
      globalThis.fetch = fetchImpl;

      const res = await proxy(buildRequest("/", { refreshToken: "rt", auth_hint: "1" }));

      expect(res.status).toBe(200);
      expect(clearedCookies(res)).toEqual([]);
    }
  });
});

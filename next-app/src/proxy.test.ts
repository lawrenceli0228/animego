import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
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
  globalThis.fetch = async () => {
    throw new Error("unexpected fetch in proxy test — mock fetch explicitly");
  };
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

describe("proxy /library + /player gate (P6 — auth required, no role check)", () => {
  test("/library no session → /login redirect with from preserved", async () => {
    const res = await proxy(buildRequest("/library"));
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("from")).toBe("/library");
  });

  test("/player no session → /login redirect with from preserved", async () => {
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

  test("/player passes through with no role claim (just a logged-in user)", async () => {
    const token = jwt.sign({ userId: "u1", username: "alice" }, SECRET);
    const res = await proxy(buildRequest("/player", { session: token }));
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
    globalThis.fetch = mock(async () =>
      new Response(null, {
        status: 200,
        headers: {
          "set-cookie": [
            `session=${newSession}; Path=/; HttpOnly`,
            `refreshToken=${newRefreshToken}; Path=/; HttpOnly`,
          ].join(", "),
        },
      }),
    ) as typeof fetch;

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
    globalThis.fetch = mock(async () =>
      new Response(null, {
        status: 200,
        headers: {
          "set-cookie": `session=${adminSession}; Path=/; HttpOnly`,
        },
      }),
    ) as typeof fetch;

    const res = await proxy(
      buildRequest("/admin/enrichment", { refreshToken: "old-rt" }),
    );
    // The refreshed token has role=admin so the gate passes
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  test("when refresh returns non-ok, falls through to gate which bounces gated route", async () => {
    globalThis.fetch = mock(async () =>
      new Response("Unauthorized", { status: 401 }),
    ) as typeof fetch;

    const res = await proxy(
      buildRequest("/admin/enrichment", { refreshToken: "expired-rt" }),
    );
    // No effective session after failed refresh → gate redirects
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
  });

  test("when fetch throws (transient network error), falls through and gate bounces gated route", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("network error");
    }) as typeof fetch;

    const res = await proxy(
      buildRequest("/library", { refreshToken: "some-rt" }),
    );
    // No effective session after transient failure → gate redirects
    expect(res.status).toBe(307);
  });

  test("non-gated route passes through even after failed refresh (renders as logged-out)", async () => {
    globalThis.fetch = mock(async () =>
      new Response("Unauthorized", { status: 401 }),
    ) as typeof fetch;

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

    globalThis.fetch = mock(async () =>
      new Response(null, {
        status: 200,
        headers: {
          "set-cookie": `session=${newSession}; Path=/; HttpOnly`,
        },
      }),
    ) as typeof fetch;

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

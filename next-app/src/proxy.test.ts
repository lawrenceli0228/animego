import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import jwt from "jsonwebtoken";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

const SECRET = "test-secret-for-proxy";
let originalSecret: string | undefined;

beforeEach(() => {
  originalSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = SECRET;
});

afterEach(() => {
  if (originalSecret === undefined) {
    delete process.env.JWT_SECRET;
  } else {
    process.env.JWT_SECRET = originalSecret;
  }
});

function buildRequest(path: string, cookies: Record<string, string> = {}) {
  const url = new URL(`https://animegoclub.com${path}`);
  const headers = new Headers();
  const cookiePairs = Object.entries(cookies).map(([k, v]) => `${k}=${v}`);
  if (cookiePairs.length) headers.set("Cookie", cookiePairs.join("; "));
  return new NextRequest(url, { headers });
}

describe("proxy /admin gate", () => {
  test("redirects to /login when session cookie is missing", () => {
    const res = proxy(buildRequest("/admin/enrichment"));
    expect(res.status).toBe(307); // NextResponse.redirect default
    const location = res.headers.get("location");
    expect(location).not.toBeNull();
    const loc = new URL(location!);
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("from")).toBe("/admin/enrichment");
  });

  test("preserves search params in `from` redirect", () => {
    const res = proxy(buildRequest("/admin/users?page=2&q=alice"));
    const location = res.headers.get("location");
    const loc = new URL(location!);
    expect(loc.searchParams.get("from")).toBe("/admin/users?page=2&q=alice");
  });

  test("returns 500 when JWT_SECRET is missing", () => {
    delete process.env.JWT_SECRET;
    const token = jwt.sign({ role: "admin" }, "anything-since-secret-is-gone");
    const res = proxy(buildRequest("/admin", { session: token }));
    expect(res.status).toBe(500);
  });

  test("redirects + clears cookie on tampered token", async () => {
    const res = proxy(buildRequest("/admin", { session: "not.a.real.jwt" }));
    expect(res.status).toBe(307);
    const location = res.headers.get("location");
    expect(new URL(location!).pathname).toBe("/login");
    // Set-Cookie header should include a `session=` clear directive
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain("session=");
    // Cleared cookies carry a past Max-Age / Expires
    expect(setCookie?.toLowerCase()).toMatch(/max-age=0|expires=/);
  });

  test("redirects on expired token", () => {
    const token = jwt.sign({ role: "admin" }, SECRET, { expiresIn: "-1h" });
    const res = proxy(buildRequest("/admin", { session: token }));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
  });

  test("returns 403 when role is not admin", () => {
    const token = jwt.sign(
      { userId: "u1", username: "alice", role: "user" },
      SECRET,
    );
    const res = proxy(buildRequest("/admin", { session: token }));
    expect(res.status).toBe(403);
  });

  test("returns 403 when role claim is missing", () => {
    const token = jwt.sign({ userId: "u1", username: "alice" }, SECRET);
    const res = proxy(buildRequest("/admin", { session: token }));
    expect(res.status).toBe(403);
  });

  test("passes through when role is admin", () => {
    const token = jwt.sign(
      { userId: "u1", username: "alice", role: "admin" },
      SECRET,
    );
    const res = proxy(buildRequest("/admin/enrichment", { session: token }));
    // NextResponse.next() returns status 200 with the rewrite header set
    expect(res.status).toBe(200);
    // No location header — we passed through, not redirected
    expect(res.headers.get("location")).toBeNull();
  });
});

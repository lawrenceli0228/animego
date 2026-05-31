import {
  describe,
  expect,
  test,
  beforeEach,
  afterEach,
  mock,
} from "bun:test";

import { authFetch } from "./authFetch";

// Mock window.location so the helper's redirect logic is observable.
// jsdom-style — we replace location.href via a setter spy.
interface MockedLocation {
  pathname: string;
  search: string;
  href: string;
}

const originalLocation = (globalThis as { window?: { location?: unknown } })
  .window?.location;

beforeEach(() => {
  // bun:test runs in a Node-like context with no `window` global; build
  // one for the helper to consume during the redirect path.
  const loc: MockedLocation = {
    pathname: "/library",
    search: "?page=1",
    href: "",
  };
  (globalThis as { window: { location: MockedLocation } }).window = {
    location: loc,
  };
});

afterEach(() => {
  if (originalLocation === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    (globalThis as { window: { location: unknown } }).window = {
      location: originalLocation,
    };
  }
  mock.restore();
});

function fetchSequence(responses: Response[]) {
  let i = 0;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const stub = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      init,
    });
    const next = responses[i];
    i += 1;
    if (!next) throw new Error(`fetch called more times than mocked (${i})`);
    return next;
  });
  return { stub, calls };
}

describe("authFetch", () => {
  test("returns response unchanged on 200", async () => {
    const { stub, calls } = fetchSequence([
      new Response(JSON.stringify({ data: 1 }), { status: 200 }),
    ]);
    globalThis.fetch = stub as unknown as typeof fetch;
    const res = await authFetch("/api/x");
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/x");
  });

  test("attaches credentials: same-origin by default", async () => {
    const { stub, calls } = fetchSequence([
      new Response("ok", { status: 200 }),
    ]);
    globalThis.fetch = stub as unknown as typeof fetch;
    await authFetch("/api/x");
    expect(calls[0]?.init?.credentials).toBe("same-origin");
  });

  test("does not retry on non-401 errors (e.g. 500)", async () => {
    const { stub, calls } = fetchSequence([
      new Response("boom", { status: 500 }),
    ]);
    globalThis.fetch = stub as unknown as typeof fetch;
    const res = await authFetch("/api/x");
    expect(res.status).toBe(500);
    expect(calls).toHaveLength(1);
  });

  test("on 401 → refresh succeeds → retry once → returns retry response", async () => {
    const { stub, calls } = fetchSequence([
      new Response("denied", { status: 401 }),
      new Response("ok-after-refresh", { status: 200 }), // /refresh
      new Response("got it", { status: 200 }), // retry
    ]);
    globalThis.fetch = stub as unknown as typeof fetch;

    const res = await authFetch("/api/x");
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual([
      "/api/x",
      "/api/auth/refresh",
      "/api/x",
    ]);
    expect(calls[1]?.init?.method).toBe("POST");
  });

  test("on 401 → refresh fails → redirect to /login?from=<path>", async () => {
    const { stub, calls } = fetchSequence([
      new Response("denied", { status: 401 }),
      new Response("nope", { status: 401 }), // /refresh also 401s
    ]);
    globalThis.fetch = stub as unknown as typeof fetch;

    const res = await authFetch("/api/x");
    // Helper returns the original 401 even after triggering navigation
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(2);

    const win = (globalThis as { window: { location: MockedLocation } })
      .window;
    expect(win.location.href).toBe("/login?from=%2Flibrary%3Fpage%3D1");
  });

  test("skipRedirectOnFailure returns the 401 without navigating", async () => {
    const { stub } = fetchSequence([
      new Response("denied", { status: 401 }),
      new Response("nope", { status: 401 }),
    ]);
    globalThis.fetch = stub as unknown as typeof fetch;

    const res = await authFetch("/api/x", { skipRedirectOnFailure: true });
    expect(res.status).toBe(401);

    const win = (globalThis as { window: { location: MockedLocation } })
      .window;
    expect(win.location.href).toBe(""); // no navigation
  });

  test("on 401 retry that 401s → still redirect (refresh succeeded, but token still bad)", async () => {
    const { stub } = fetchSequence([
      new Response("denied", { status: 401 }),
      new Response("ok", { status: 200 }), // /refresh
      new Response("still denied", { status: 401 }), // retry
    ]);
    globalThis.fetch = stub as unknown as typeof fetch;
    await authFetch("/api/x");
    const win = (globalThis as { window: { location: MockedLocation } })
      .window;
    expect(win.location.href).toBe("/login?from=%2Flibrary%3Fpage%3D1");
  });
});

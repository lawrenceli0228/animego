import { describe, expect, mock, test, beforeEach, afterEach } from "bun:test";
import { apiGet, apiMutate, buildHeaders } from "./api";

const originalFetch = globalThis.fetch;
const originalWindow = (globalThis as { window?: unknown }).window;
const originalEnv = process.env.GO_API_INTERNAL_URL;

beforeEach(() => {
  delete (globalThis as { window?: unknown }).window;
  delete process.env.GO_API_INTERNAL_URL;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow !== undefined) {
    (globalThis as { window?: unknown }).window = originalWindow;
  } else {
    delete (globalThis as { window?: unknown }).window;
  }
  if (originalEnv !== undefined) {
    process.env.GO_API_INTERNAL_URL = originalEnv;
  } else {
    delete process.env.GO_API_INTERNAL_URL;
  }
});

describe("buildHeaders (anon vs authed)", () => {
  // Deterministic, RSC-independent case: auth:false MUST return exactly the
  // minimal headers and never touch cookies()/headers(). This is the
  // ISR-safe path detail pages rely on.
  test("buildHeaders(false) returns exactly { Accept } and nothing else", async () => {
    const headers = await buildHeaders(false);
    expect(headers).toEqual({ Accept: "application/json" });
    expect(headers).not.toHaveProperty("Cookie");
    expect(headers).not.toHaveProperty("X-Real-IP");
    expect(headers).not.toHaveProperty("X-Forwarded-For");
  });

  // No RSC context exists inside bun test, so cookies() throws and is caught
  // → the authed path also degrades to anonymous headers. We can therefore
  // only assert that the default (auth omitted) and auth:true paths produce
  // the same minimal envelope here; the real cookie/IP forwarding can only be
  // exercised inside an actual RSC call stack and is not unit-testable here.
  test("default (auth omitted) yields minimal headers in a non-RSC context", async () => {
    const headers = await buildHeaders();
    expect(headers).toEqual({ Accept: "application/json" });
  });

  test("buildHeaders(true) yields minimal headers in a non-RSC context", async () => {
    const headers = await buildHeaders(true);
    expect(headers).toEqual({ Accept: "application/json" });
  });
});

describe("auth option threads through to the outgoing request", () => {
  test("apiGet with { auth: false } sends no Cookie header on the wire", async () => {
    const spy = mock(
      async () =>
        new Response(JSON.stringify({ data: { ok: true } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    globalThis.fetch = spy as unknown as typeof fetch;
    await apiGet("/api/anime/154587", { revalidate: 60, auth: false });
    const init = spy.mock.calls[0][1] as { headers?: Record<string, string> };
    expect(init.headers).toEqual({ Accept: "application/json" });
    expect(init.headers).not.toHaveProperty("Cookie");
  });

  test("apiMutate with { auth: false } and a body still omits Cookie but keeps Content-Type", async () => {
    const spy = mock(
      async () =>
        new Response(JSON.stringify({ data: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    globalThis.fetch = spy as unknown as typeof fetch;
    await apiMutate("/x", "POST", { body: { k: "v" }, auth: false });
    const init = spy.mock.calls[0][1] as { headers?: Record<string, string> };
    expect(init.headers?.["Content-Type"]).toBe("application/json");
    expect(init.headers).not.toHaveProperty("Cookie");
  });
});

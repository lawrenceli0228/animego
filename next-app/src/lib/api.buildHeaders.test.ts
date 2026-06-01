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

  // NOTE: the authed path (auth omitted / auth:true) reads cookies()/headers(),
  // which only resolve inside a real RSC call stack — not deterministically
  // unit-testable here (and fragile under other test files' global
  // next/headers module mocks). Its cookie/IP forwarding is exercised by
  // integration + live testing instead; what matters for ISR is the anon
  // path above, which never touches next/headers.
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

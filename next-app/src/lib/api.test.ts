import { describe, expect, mock, test, beforeEach, afterEach } from "bun:test";
import { ApiError, apiGet, apiGetEnvelope, apiGetPaged, apiMutate, getApiBase } from "./api";

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

describe("getApiBase", () => {
  test("returns empty string in browser context (typeof window defined)", () => {
    (globalThis as { window?: unknown }).window = {};
    expect(getApiBase()).toBe("");
  });

  test("returns GO_API_INTERNAL_URL env when set on server", () => {
    process.env.GO_API_INTERNAL_URL = "http://go-api.internal:8080";
    expect(getApiBase()).toBe("http://go-api.internal:8080");
  });

  test("returns http://localhost:8080 default on server with no env", () => {
    expect(getApiBase()).toBe("http://localhost:8080");
  });
});

describe("apiGet", () => {
  test("unwraps {data: T} envelope on 200", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ data: { foo: 1, bar: "x" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as typeof fetch;
    const result = await apiGet<{ foo: number; bar: string }>("/x");
    expect(result).toEqual({ foo: 1, bar: "x" });
  });

  test("throws ApiError carrying the {error: {code, message}} body on 4xx", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({ error: { code: "NOT_FOUND", message: "gone" } }),
          { status: 404, headers: { "content-type": "application/json" } },
        ),
    ) as typeof fetch;
    await expect(apiGet("/x")).rejects.toBeInstanceOf(ApiError);
    await expect(apiGet("/x")).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "gone",
      status: 404,
    });
  });

  test("throws ApiError on non-JSON 5xx response", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response("Internal Server Error", {
          status: 500,
          headers: { "content-type": "text/plain" },
        }),
    ) as typeof fetch;
    await expect(apiGet("/x")).rejects.toMatchObject({
      code: "INVALID_JSON",
      status: 500,
    });
  });

  test("wraps fetch network failure as ApiError(NETWORK_ERROR)", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("econnrefused");
    }) as typeof fetch;
    await expect(apiGet("/x")).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      status: 0,
    });
  });

  test("passes revalidate option through to Next fetch", async () => {
    const spy = mock(
      async () =>
        new Response(JSON.stringify({ data: 42 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    globalThis.fetch = spy as unknown as typeof fetch;
    await apiGet("/x", { revalidate: 60 });
    expect(spy).toHaveBeenCalledTimes(1);
    const init = spy.mock.calls[0][1] as { next?: { revalidate?: number } };
    expect(init.next?.revalidate).toBe(60);
  });

  test("defaults to cache: 'no-store' when no revalidate given", async () => {
    const spy = mock(
      async () =>
        new Response(JSON.stringify({ data: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    globalThis.fetch = spy as unknown as typeof fetch;
    await apiGet("/x");
    const init = spy.mock.calls[0][1] as { cache?: string };
    expect(init.cache).toBe("no-store");
  });

  test("prepends getApiBase() to relative path on server", async () => {
    process.env.GO_API_INTERNAL_URL = "http://example:9999";
    const spy = mock(
      async () =>
        new Response(JSON.stringify({ data: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    globalThis.fetch = spy as unknown as typeof fetch;
    await apiGet("/api/anime/trending");
    expect(spy.mock.calls[0][0]).toBe("http://example:9999/api/anime/trending");
  });
});

describe("apiGetPaged", () => {
  test("returns full paged envelope (hasMore=true case)", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ id: 1 }, { id: 2 }],
            total: 100,
            page: 1,
            hasMore: true,
            nextPage: 2,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    ) as typeof fetch;
    const result = await apiGetPaged<{ id: number }>("/x");
    expect(result).toEqual({
      data: [{ id: 1 }, { id: 2 }],
      total: 100,
      page: 1,
      hasMore: true,
      nextPage: 2,
    });
  });

  test("preserves nextPage: null on last page", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ id: 99 }],
            total: 100,
            page: 50,
            hasMore: false,
            nextPage: null,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    ) as typeof fetch;
    const result = await apiGetPaged<{ id: number }>("/x");
    expect(result.nextPage).toBeNull();
    expect(result.hasMore).toBe(false);
  });
});

describe("apiMutate", () => {
  test("POSTs body as JSON and unwraps envelope", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({ data: { _id: "u1", username: "alice" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ) as typeof fetch;
    const result = await apiMutate<{ _id: string; username: string }>(
      "/api/admin/users",
      "POST",
      { body: { username: "alice", email: "a@b.c", password: "pw" } },
    );
    expect(result).toEqual({ _id: "u1", username: "alice" });
  });

  test("sets Content-Type: application/json when body is provided", async () => {
    const spy = mock(
      async () =>
        new Response(JSON.stringify({ data: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    globalThis.fetch = spy as unknown as typeof fetch;
    await apiMutate("/x", "POST", { body: { key: "val" } });
    const init = spy.mock.calls[0][1] as { headers?: Record<string, string> };
    expect(init.headers?.["Content-Type"]).toBe("application/json");
  });

  test("omits Content-Type header when no body", async () => {
    const spy = mock(
      async () =>
        new Response(JSON.stringify({ data: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    globalThis.fetch = spy as unknown as typeof fetch;
    await apiMutate("/x", "DELETE");
    const init = spy.mock.calls[0][1] as { headers?: Record<string, string> };
    expect(init.headers?.["Content-Type"]).toBeUndefined();
  });

  test("returns undefined for 204 No Content", async () => {
    globalThis.fetch = mock(
      async () => new Response(null, { status: 204 }),
    ) as typeof fetch;
    const result = await apiMutate("/x", "DELETE");
    expect(result).toBeUndefined();
  });

  test("throws ApiError on 4xx response with error envelope", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({ error: { code: "FORBIDDEN", message: "nope" } }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
    ) as typeof fetch;
    await expect(apiMutate("/x", "POST")).rejects.toBeInstanceOf(ApiError);
    await expect(apiMutate("/x", "POST")).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
  });

  test("throws ApiError on network failure", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("timeout");
    }) as typeof fetch;
    await expect(apiMutate("/x", "PATCH", { body: {} })).rejects.toMatchObject(
      { code: "NETWORK_ERROR", status: 0 },
    );
  });

  test("throws ApiError on non-JSON body", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response("Gateway Timeout", {
          status: 504,
          headers: { "content-type": "text/plain" },
        }),
    ) as typeof fetch;
    await expect(apiMutate("/x", "POST")).rejects.toMatchObject({
      code: "INVALID_JSON",
      status: 504,
    });
  });

  test("uses DELETE method on the wire", async () => {
    const spy = mock(
      async () =>
        new Response(JSON.stringify({ data: { deleted: true } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    globalThis.fetch = spy as unknown as typeof fetch;
    await apiMutate("/api/admin/users/u1", "DELETE");
    expect((spy.mock.calls[0][1] as RequestInit).method).toBe("DELETE");
  });
});

describe("apiGetEnvelope", () => {
  test("returns the raw envelope body without unwrapping data", async () => {
    const envelope = { data: [{ id: 1 }], total: 1 };
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify(envelope), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as typeof fetch;
    const result = await apiGetEnvelope<typeof envelope>("/x");
    expect(result).toEqual(envelope);
  });

  test("throws ApiError on error response", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({ error: { code: "NOT_FOUND", message: "gone" } }),
          { status: 404, headers: { "content-type": "application/json" } },
        ),
    ) as typeof fetch;
    await expect(
      apiGetEnvelope("/x"),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

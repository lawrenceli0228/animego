import { describe, expect, test, mock } from "bun:test";
import { submitForgotPassword } from "./forgotPasswordFlow";

// extractServerMessage is covered in lib/authForm.test.ts — this file
// only verifies the /forgot-password-specific wire-up (endpoint,
// payload shape, credential mode, status mapping).

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("submitForgotPassword", () => {
  test("posts JSON + credentials and returns ok on 200", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchFn = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: String(input), init: init ?? {} };
      return jsonResponse(200, {
        data: { message: "如果该邮箱已注册，你将收到重置链接" },
      });
    });

    const result = await submitForgotPassword("alice@example.com", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: true, status: 200, message: "" });
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("/api/auth/forgot-password");
    expect(captured!.init.method).toBe("POST");
    expect(captured!.init.credentials).toBe("same-origin");
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(captured!.init.body).toBe(
      JSON.stringify({ email: "alice@example.com" }),
    );
  });

  test("maps 429 from authLimiter into the result (real backend code + copy)", async () => {
    // Mirror server/middleware/rateLimiter.js — authLimiter emits
    // { error: { code: 'TOO_MANY_REQUESTS', message: '登录尝试过多，请 15 分钟后再试' } }
    // The previous fixture used the generic forgot-only copy; this keeps
    // the test honest if anyone greps for the real production string.
    const fetchFn = mock(async () =>
      jsonResponse(429, {
        error: {
          code: "TOO_MANY_REQUESTS",
          message: "登录尝试过多，请 15 分钟后再试",
        },
      }),
    );
    const result = await submitForgotPassword("a@b.c", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toEqual({
      ok: false,
      status: 429,
      message: "登录尝试过多，请 15 分钟后再试",
    });
  });

  test("falls back to HTTP status string when error body has no message", async () => {
    const fetchFn = mock(async () =>
      new Response("upstream exploded", { status: 502 }),
    );
    const result = await submitForgotPassword("a@b.c", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, status: 502, message: "HTTP 502" });
  });

  test("returns ok:false on network failure (fetch throws)", async () => {
    const fetchFn = mock(async () => {
      throw new TypeError("Failed to fetch");
    });
    const result = await submitForgotPassword("a@b.c", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.message).toBe("Failed to fetch");
  });
});

import { describe, expect, test, mock } from "bun:test";
import { submitResetPassword } from "./resetPasswordFlow";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("submitResetPassword", () => {
  test("posts JSON + credentials and returns ok on 200", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchFn = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: String(input), init: init ?? {} };
      return jsonResponse(200, { data: { message: "密码已重置，请重新登录" } });
    });

    const result = await submitResetPassword("abc123token", "hunter2", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: true, status: 200, message: "" });
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("/api/auth/reset-password/abc123token");
    expect(captured!.init.method).toBe("POST");
    expect(captured!.init.credentials).toBe("same-origin");
    expect(captured!.init.body).toBe(JSON.stringify({ password: "hunter2" }));
  });

  test("maps 400 INVALID_TOKEN into the result", async () => {
    const fetchFn = mock(async () =>
      jsonResponse(400, {
        error: { code: "INVALID_TOKEN", message: "链接无效或已过期，请重新申请" },
      }),
    );
    const result = await submitResetPassword("expired-token", "hunter2", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toEqual({
      ok: false,
      status: 400,
      message: "链接无效或已过期，请重新申请",
    });
  });

  test("maps 400 VALIDATION_ERROR (password rule)", async () => {
    const fetchFn = mock(async () =>
      jsonResponse(400, {
        error: { code: "VALIDATION_ERROR", message: "密码至少 6 位" },
      }),
    );
    const result = await submitResetPassword("token", "abc", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, status: 400, message: "密码至少 6 位" });
  });

  test("falls back to HTTP status string when error body has no message", async () => {
    const fetchFn = mock(async () =>
      new Response("upstream exploded", { status: 502 }),
    );
    const result = await submitResetPassword("token", "hunter2", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, status: 502, message: "HTTP 502" });
  });

  test("returns ok:false on network failure (fetch throws)", async () => {
    const fetchFn = mock(async () => {
      throw new TypeError("Failed to fetch");
    });
    const result = await submitResetPassword("token", "hunter2", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.message).toBe("Failed to fetch");
  });

  test("encodes the token in the URL (encodeURIComponent is wired)", async () => {
    let capturedUrl = "";
    const fetchFn = mock(async (input: RequestInfo | URL) => {
      capturedUrl = String(input);
      return jsonResponse(200, { data: { message: "ok" } });
    });
    await submitResetPassword("abc/def", "hunter2", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(capturedUrl).toBe("/api/auth/reset-password/abc%2Fdef");
  });
});

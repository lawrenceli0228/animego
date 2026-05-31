import { describe, expect, test, mock } from "bun:test";
import { submitRegister } from "./registerFlow";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("submitRegister", () => {
  test("posts JSON + credentials and returns ok on 201 (Express returns 201, not 200)", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchFn = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: String(input), init: init ?? {} };
      return jsonResponse(201, {
        data: { accessToken: "tok", user: { username: "alice" } },
      });
    });

    const result = await submitRegister("alice", "alice@example.com", "hunter2", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: true, status: 201, message: "" });
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("/api/auth/register");
    expect(captured!.init.method).toBe("POST");
    expect(captured!.init.credentials).toBe("same-origin");
    expect(captured!.init.body).toBe(
      JSON.stringify({
        username: "alice",
        email: "alice@example.com",
        password: "hunter2",
      }),
    );
  });

  test("maps 400 DUPLICATE_ERROR into the result", async () => {
    const fetchFn = mock(async () =>
      jsonResponse(400, {
        error: { code: "DUPLICATE_ERROR", message: "用户名或邮箱已存在" },
      }),
    );
    const result = await submitRegister("alice", "alice@example.com", "hunter2", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, status: 400, message: "用户名或邮箱已存在" });
  });

  test("maps 400 VALIDATION_ERROR (username length / email / password rules)", async () => {
    const fetchFn = mock(async () =>
      jsonResponse(400, {
        error: { code: "VALIDATION_ERROR", message: "用户名需 3-50 个字符" },
      }),
    );
    const result = await submitRegister("ab", "alice@example.com", "hunter2", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toEqual({
      ok: false,
      status: 400,
      message: "用户名需 3-50 个字符",
    });
  });

  test("falls back to HTTP status string when error body has no message", async () => {
    const fetchFn = mock(async () =>
      new Response("upstream exploded", { status: 502 }),
    );
    const result = await submitRegister("alice", "a@b.c", "hunter2", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, status: 502, message: "HTTP 502" });
  });

  test("returns ok:false on network failure (fetch throws)", async () => {
    const fetchFn = mock(async () => {
      throw new TypeError("Failed to fetch");
    });
    const result = await submitRegister("alice", "a@b.c", "hunter2", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.message).toBe("Failed to fetch");
  });
});

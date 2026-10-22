import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { endOtherSessions, endSession, patchMe, sendPasswordLink } from "./settingsApi";

interface Call {
  url: string;
  init?: RequestInit;
}

const realFetch = globalThis.fetch;
let calls: Call[] = [];

/** Answer every request with `respond`, recording what was asked. */
function stubFetch(respond: () => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: typeof input === "string" ? input : input.toString(), init });
    return respond();
  }) as typeof fetch;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("patchMe", () => {
  test("PATCHes /api/auth/me and returns what the server now holds", async () => {
    stubFetch(() =>
      json(200, { data: { user: { username: "shiro", usernameHidden: false, avatarUrl: null, backdropAnilistId: 21 } } }),
    );
    const outcome = await patchMe({ backdropAnilistId: 21 }, "zh");
    expect(outcome).toEqual({
      ok: true,
      value: { username: "shiro", usernameHidden: false, photo: null, backdrop: 21 },
      error: "",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/auth/me");
    expect(calls[0]?.init?.method).toBe("PATCH");
    expect(calls[0]?.init?.credentials).toBe("same-origin");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ backdropAnilistId: 21 });
  });

  test("passes the server's message through on failure", async () => {
    stubFetch(() => json(409, { error: { code: "DUPLICATE", message: "Username already taken" } }));
    expect(await patchMe({ username: "taken" }, "en")).toEqual({ ok: false, value: null, error: "Username already taken" });
  });

  test("falls back to the reader's language when the server says nothing", async () => {
    stubFetch(() => new Response("oops", { status: 500 }));
    expect(await patchMe({ isPublic: false }, "zh")).toEqual({ ok: false, value: null, error: "保存失败" });
    expect(await patchMe({ isPublic: false }, "zh-Hant")).toEqual({ ok: false, value: null, error: "儲存失敗" });
  });

  test("reports a network failure as one", async () => {
    stubFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    expect(await patchMe({ isPublic: true }, "en")).toEqual({ ok: false, value: null, error: "Network error" });
  });
});

describe("sendPasswordLink", () => {
  test("POSTs the email to the forgot-password endpoint", async () => {
    stubFetch(() => json(200, { data: { message: "If the email is registered, you will receive a reset link" } }));
    expect(await sendPasswordLink("shiro@example.com", "zh")).toEqual({ ok: true, value: null, error: "" });
    expect(calls[0]?.url).toBe("/api/auth/forgot-password");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ email: "shiro@example.com" });
  });

  test("says why when the server refuses", async () => {
    stubFetch(() => json(429, { error: { code: "TOO_MANY_REQUESTS", message: "Too many requests, please try again later" } }));
    expect(await sendPasswordLink("shiro@example.com", "en")).toEqual({
      ok: false,
      value: null,
      error: "Too many requests, please try again later",
    });
  });
});

describe("endSession", () => {
  test("DELETEs the one session, by its id", async () => {
    stubFetch(() => json(200, { data: { revoked: 1 } }));
    expect(await endSession("0b6e2f8c-7a44-4c3a-b2b1-1f9d6a3e5c02", "zh")).toEqual({ ok: true, value: null, error: "" });
    expect(calls[0]?.url).toBe("/api/auth/sessions/0b6e2f8c-7a44-4c3a-b2b1-1f9d6a3e5c02");
    expect(calls[0]?.init?.method).toBe("DELETE");
  });

  test("keeps an odd id inside its path segment", async () => {
    stubFetch(() => json(200, { data: { revoked: 1 } }));
    await endSession("../me", "zh");
    expect(calls[0]?.url).toBe("/api/auth/sessions/..%2Fme");
  });

  test("falls back to a sign-out failure in the reader's language", async () => {
    stubFetch(() => json(400, {}));
    expect(await endSession("x", "zh")).toEqual({ ok: false, value: null, error: "退出失败" });
    expect(await endSession("x", "en")).toEqual({ ok: false, value: null, error: "Could not sign out" });
  });
});

describe("endOtherSessions", () => {
  test("DELETEs the collection and reports how many ended", async () => {
    stubFetch(() => json(200, { data: { revoked: 5 } }));
    expect(await endOtherSessions(3, "zh")).toEqual({ ok: true, value: 5, error: "" });
    expect(calls[0]?.url).toBe("/api/auth/sessions");
    expect(calls[0]?.init?.method).toBe("DELETE");
  });

  test("assumes the ones on screen ended when the count is missing", async () => {
    stubFetch(() => json(200, { data: {} }));
    expect(await endOtherSessions(3, "zh")).toEqual({ ok: true, value: 3, error: "" });
  });

  test("passes the server's refusal through", async () => {
    stubFetch(() => json(400, { error: { code: "VALIDATION", message: "current session unknown" } }));
    expect(await endOtherSessions(2, "en")).toEqual({ ok: false, value: null, error: "current session unknown" });
  });
});

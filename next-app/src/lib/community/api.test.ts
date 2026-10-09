import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mockFetch } from "@/lib/test-utils/fetchMock";
import { createReview, errorKey, fetchSummary, followAnime, setHelpful, type ApiResult } from "./api";

const originalFetch = globalThis.fetch;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("the community API client", () => {
  test("reads the summary from the anime's community path and parses it", async () => {
    const spy = mockFetch(async () => json(200, { data: { reviews: { items: [], total: 0 }, viewer: null } }));
    globalThis.fetch = spy;
    const result = await fetchSummary(154587);
    expect(spy.mock.calls[0][0]).toBe("/api/anime/154587/community");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.reviews.total).toBe(0);
  });

  test("a write sends JSON with the method the endpoint takes", async () => {
    const spy = mockFetch(async () =>
      json(201, {
        data: {
          id: "r1",
          author: { username: "alice" },
          summary: "一句话总结一下这部番",
          body: "x",
          createdAt: "2026-10-01T00:00:00Z",
        },
      }),
    );
    globalThis.fetch = spy;
    const result = await createReview(1, { summary: "一句话总结一下这部番", body: "x", isSpoiler: false, isPrivate: true });
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe("/api/anime/1/community/reviews");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ summary: "一句话总结一下这部番", body: "x", isSpoiler: false, isPrivate: true });
    expect(result.ok).toBe(true);
  });

  test("a vote is PUT and taking it back is DELETE", async () => {
    const spy = mockFetch(async () => json(200, { data: { voted: true, helpfulCount: 4 } }));
    globalThis.fetch = spy;
    expect(await setHelpful(1, "r1", true)).toEqual({ ok: true, data: 4 });
    await setHelpful(1, "r1", false);
    expect(spy.mock.calls.map(([, init]) => init?.method)).toEqual(["PUT", "DELETE"]);
  });

  test("an error envelope comes back as a failure with its status and code", async () => {
    globalThis.fetch = mockFetch(async () => json(409, { error: { code: "CONFLICT", message: "You have already reviewed this anime" } }));
    const result = await createReview(1, { summary: "x", body: "y", isSpoiler: false, isPrivate: false });
    expect(result).toEqual({ ok: false, status: 409, code: "CONFLICT", message: "You have already reviewed this anime" });
  });

  test("a body that does not parse is a failure, not a crash", async () => {
    globalThis.fetch = mockFetch(async () => json(200, { data: { reviews: "nope" } }));
    expect((await fetchSummary(1)).ok).toBe(true);
    globalThis.fetch = mockFetch(async () => new Response("<html>", { status: 502 }));
    expect(await fetchSummary(1)).toEqual({ ok: false, status: 502, code: "", message: "" });
    globalThis.fetch = mockFetch(async () => {
      throw new TypeError("offline");
    });
    expect(await fetchSummary(1)).toEqual({ ok: false, status: 0, code: "NETWORK_ERROR", message: "" });
  });

  test("following the anime is an idempotent watching subscription", async () => {
    const spy = mockFetch(async () => json(201, { data: { status: "completed", currentEpisode: 28, score: null } }));
    globalThis.fetch = spy;
    expect(await followAnime(154587)).toEqual({ ok: true, data: { status: "completed", currentEpisode: 28, score: null } });
    expect(JSON.parse(String(spy.mock.calls[0][1]?.body))).toEqual({ anilistId: 154587, status: "watching", ifAbsent: true });
  });
});

test("errorKey says each failure in the page's own words", () => {
  const fail = (status: number): ApiResult<unknown> => ({ ok: false, status, code: "", message: "" });
  expect(errorKey(fail(401))).toBe("community.errorLogin");
  expect(errorKey(fail(403))).toBe("community.errorBlocked");
  expect(errorKey(fail(404))).toBe("community.errorGone");
  expect(errorKey(fail(409))).toBe("community.errorAlreadyReviewed");
  expect(errorKey(fail(429))).toBe("community.errorTooMany");
  expect(errorKey(fail(400))).toBe("community.errorInvalid");
  expect(errorKey(fail(500))).toBe("community.errorFailed");
  expect(errorKey(fail(0))).toBe("community.errorFailed");
});

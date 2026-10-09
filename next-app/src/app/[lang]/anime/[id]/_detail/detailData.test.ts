import { afterEach, describe, expect, test } from "bun:test";

import { mockFetch } from "@/lib/test-utils/fetchMock";
import { loadCommunityCount, loadKnownDetail, parseAnimeId } from "./detailData";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** A go-api stand-in: answers by path, records every path it was asked. */
function goApi(routes: Record<string, { status: number; body?: unknown }>) {
  const asked: string[] = [];
  globalThis.fetch = mockFetch(async (input) => {
    const path = new URL(String(input)).pathname;
    asked.push(path);
    const route = routes[path] ?? { status: 404, body: { error: { code: "NOT_FOUND", message: "not found" } } };
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status,
      headers: { "Content-Type": "application/json" },
    });
  });
  return asked;
}

// The id in /anime/[id]/… decides whether go-api is asked at all: anything
// that is not an AniList id is a 404 before any request.

describe("parseAnimeId", () => {
  test("a positive int32 in plain digits is an id", () => {
    expect(parseAnimeId("154587")).toBe(154587);
    expect(parseAnimeId("1")).toBe(1);
    expect(parseAnimeId("2147483647")).toBe(2147483647);
  });

  test("anything else is not", () => {
    for (const raw of ["", "0", "-1", "1.5", "abc", "1e3", "0154587", " 1", "1 ", "+1", "2147483648", "99999999999"]) {
      expect(parseAnimeId(raw)).toBeNull();
    }
  });
});

describe("loadKnownDetail", () => {
  test("an id the catalogue does not hold is null, and the detail is never asked for", async () => {
    const asked = goApi({});
    expect(await loadKnownDetail(424242)).toBeNull();
    expect(asked).toEqual(["/api/anime/424242/credit-counts"]);
  });

  test("a held id reads the counts first, then the detail", async () => {
    const asked = goApi({
      "/api/anime/7/credit-counts": { status: 200, body: { data: { characters: 1, staff: 2 } } },
      "/api/anime/7": { status: 200, body: { data: { anilistId: 7, titleRomaji: "Seven" } } },
    });
    expect((await loadKnownDetail(7))?.anilistId).toBe(7);
    expect(asked).toEqual(["/api/anime/7/credit-counts", "/api/anime/7"]);
  });
});

describe("loadCommunityCount", () => {
  test("the total go-api answers", async () => {
    goApi({ "/api/anime/7/community/count": { status: 200, body: { data: { total: 3 } } } });
    expect(await loadCommunityCount(7)).toBe(3);
  });

  test("a zero is a count", async () => {
    goApi({ "/api/anime/7/community/count": { status: 200, body: { data: { total: 0 } } } });
    expect(await loadCommunityCount(7)).toBe(0);
  });

  test("any failure is null, never a made-up zero, and never throws", async () => {
    goApi({ "/api/anime/7/community/count": { status: 500, body: { error: { code: "SERVER_ERROR", message: "x" } } } });
    expect(await loadCommunityCount(7)).toBeNull();
    goApi({});
    expect(await loadCommunityCount(7)).toBeNull();
    goApi({ "/api/anime/7/community/count": { status: 200, body: { data: { total: "3" } } } });
    expect(await loadCommunityCount(7)).toBeNull();
  });
});

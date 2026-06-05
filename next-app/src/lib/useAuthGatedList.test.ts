import { describe, expect, test } from "bun:test";
import { unwrapList } from "./useAuthGatedList";

// Pure-logic tests. The React hook's auth-gate wiring (auth_hint → authFetch →
// status: loading | anonymous | ready) is exercised by the homepage E2E; here
// we lock the envelope-unwrap contract — the regression-prone bit. The two
// islands hit endpoints with DIFFERENT envelopes:
//   /api/subscriptions → { data: WatchingItem[] }
//   /api/feed          → { data: FeedItem[], hasMore, nextPage }
// and a malformed body MUST degrade to [] (the island renders empty / hides,
// never throws into the tree). This catches the exact class of bug where the
// feed's extra fields, or a non-array `data`, would otherwise blow up render.

describe("unwrapList", () => {
  test("unwraps the {data: [...]} envelope (subscriptions shape)", () => {
    expect(
      unwrapList({ data: [{ anilistId: 1 }, { anilistId: 2 }] }),
    ).toEqual([{ anilistId: 1 }, { anilistId: 2 }]);
  });

  test("unwraps {data, hasMore, nextPage} and drops the extras (feed shape)", () => {
    const out = unwrapList({
      data: [{ username: "a" }],
      hasMore: true,
      nextPage: 2,
    });
    expect(out).toEqual([{ username: "a" }]);
  });

  test("tolerates a bare array", () => {
    expect(unwrapList([{ x: 1 }])).toEqual([{ x: 1 }]);
  });

  test("empty data array stays empty", () => {
    expect(unwrapList({ data: [] })).toEqual([]);
  });

  test("data:null degrades to []", () => {
    expect(unwrapList({ data: null })).toEqual([]);
  });

  test("non-array data degrades to [] (never throws into the tree)", () => {
    expect(unwrapList({ data: "nope" })).toEqual([]);
  });

  test("null / undefined / primitive bodies degrade to []", () => {
    expect(unwrapList(null)).toEqual([]);
    expect(unwrapList(undefined)).toEqual([]);
    expect(unwrapList("string")).toEqual([]);
    expect(unwrapList(42)).toEqual([]);
  });
});

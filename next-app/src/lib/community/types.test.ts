import { describe, expect, test } from "bun:test";
import { parseActivity, parsePage, parseReview, parseSummary, parseThreadView, parseWatchers } from "./types";

const author = { username: "alice", avatarUrl: null, backdropCoverUrl: null };

describe("parsers take untrusted JSON", () => {
  test("a summary with one bad item keeps the good ones", () => {
    const summary = parseSummary({
      reviews: {
        items: [
          { id: "r1", author, summary: "一句话总结一下这部番", body: "x", createdAt: "2026-10-01T00:00:00Z" },
          { id: "r2", summary: "no author" },
        ],
        total: 2,
        page: 1,
        hasMore: false,
        nextPage: null,
      },
      threads: null,
      activity: { items: [{ id: "e1", author, status: "completed", createdAt: "2026-10-01T00:00:00Z" }] },
      watchers: { items: [], total: 0, counts: {} },
      viewer: { status: "completed", reviewId: "r1" },
    });
    expect(summary?.reviews.items.map((r) => r.id)).toEqual(["r1"]);
    expect(summary?.threads.items).toEqual([]);
    expect(summary?.activity.items[0].status).toBe("completed");
    expect(summary?.viewer).toEqual({ status: "completed", reviewId: "r1" });
  });

  test("an anonymous summary has no viewer, and garbage is null", () => {
    expect(parseSummary({ viewer: null })?.viewer).toBeNull();
    expect(parseSummary("nope")).toBeNull();
    expect(parseSummary(null)).toBeNull();
  });

  test("numbers and flags default safely", () => {
    const r = parseReview({
      id: "r1",
      author,
      summary: "一句话总结一下这部番",
      createdAt: "2026-10-01T00:00:00Z",
      helpfulCount: -3,
      viewerVoted: "yes",
    });
    expect(r).toMatchObject({ helpfulCount: 0, viewerVoted: false, body: "", updatedAt: "2026-10-01T00:00:00Z" });
  });

  test("an activity needs a known status", () => {
    expect(parseActivity({ id: "e1", author, status: "rewatching", createdAt: "x" })).toBeNull();
  });

  test("a page's total is never smaller than what it holds", () => {
    const p = parsePage({ items: [1, 2, 3], total: 1 }, (n) => (typeof n === "number" ? n : null));
    expect(p.total).toBe(3);
    expect(p.page).toBe(1);
  });

  test("a thread view needs its thread", () => {
    expect(parseThreadView({ replies: [] })).toBeNull();
    const view = parseThreadView({
      thread: { id: "t1", author, title: "第五集讨论", body: "说说看", createdAt: "2026-10-01T00:00:00Z" },
      replies: [{ id: "x", author, body: "", createdAt: "2026-10-01T00:00:00Z" }],
    });
    expect(view?.thread.title).toBe("第五集讨论");
    expect(view?.replies).toEqual([]);
  });

  test("watchers counts", () => {
    expect(parseWatchers({ items: [{ username: "bob", status: "watching", since: "2026-10-01T00:00:00Z" }], total: 1, counts: { watching: 1 } })).toEqual({
      items: [{ username: "bob", avatarUrl: null, backdropCoverUrl: null, status: "watching", currentEpisode: 0, since: "2026-10-01T00:00:00Z" }],
      total: 1,
      counts: { watching: 1, completed: 0, planToWatch: 0, dropped: 0 },
    });
  });
});

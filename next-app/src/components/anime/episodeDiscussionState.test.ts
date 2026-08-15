import { describe, expect, test } from "bun:test";
import {
  applyDiscussionDelta,
  discussionHash,
  discussionTargetFromHref,
  deletedCommentCount,
  parseDiscussionHash,
  parseEpisodeDiscussionSummary,
  updateDiscussionCount,
} from "./episodeDiscussionState";

describe("parseEpisodeDiscussionSummary", () => {
  test("parses, sorts and caps previews", () => {
    const rows = parseEpisodeDiscussionSummary({
      data: [
        { episode: 2, count: 3, latest: [
          { id: "c1", userId: "u1", username: "A", content: "one", createdAt: "2026-01-01" },
          { id: "c2", userId: "u2", username: "B", content: "two", createdAt: "2026-01-02" },
          { id: "c3", userId: "u3", username: "C", content: "three", createdAt: "2026-01-03" },
        ] },
        { episode: 1, count: 0, latest: [] },
      ],
    });
    expect(rows.map((row) => row.episode)).toEqual([1, 2]);
    expect(rows[1].latest.map((item) => item.id)).toEqual(["c1", "c2"]);
  });

  test("drops malformed rows and previews", () => {
    expect(parseEpisodeDiscussionSummary({ data: [null, { episode: -1, count: 2 }] })).toEqual([]);
    expect(parseEpisodeDiscussionSummary({ data: [{ episode: 1, count: 2, latest: [{ id: "bad" }] }] })[0].latest).toEqual([]);
  });

  test("keeps a spoiler preview without exposing its content", () => {
    const rows = parseEpisodeDiscussionSummary({
      data: [{
        episode: 1,
        count: 1,
        latest: [{
          id: "c1",
          userId: "u1",
          username: "A",
          content: "",
          isSpoiler: true,
          createdAt: "2026-01-01",
        }],
      }],
    });
    expect(rows[0].latest[0]).toMatchObject({ content: "", isSpoiler: true });
  });
});

describe("discussion hashes", () => {
  test("round-trips an episode and comment", () => {
    const hash = discussionHash(8, "550e8400-e29b-41d4-a716-446655440000");
    expect(parseDiscussionHash(hash)).toEqual({ episode: 8, commentId: "550e8400-e29b-41d4-a716-446655440000" });
  });

  test("accepts an episode-only target and rejects unsafe values", () => {
    expect(parseDiscussionHash("#episode-3")).toEqual({ episode: 3, commentId: null });
    expect(parseDiscussionHash("#episode-0")).toBeNull();
    expect(parseDiscussionHash("#episode-2-comment-../../x")).toBeNull();
    expect(parseDiscussionHash("#episode-2-comment-%E0%A4%A")).toBeNull();
    expect(discussionHash(0)).toBe("");
  });

  test("only resolves same-page hrefs", () => {
    expect(
      discussionTargetFromHref(
        "/anime/1#episode-4-comment-c1",
        "/anime/1",
      ),
    ).toEqual({ episode: 4, commentId: "c1" });
    expect(
      discussionTargetFromHref("/anime/2#episode-4", "/anime/1"),
    ).toBeNull();
  });
});

describe("updateDiscussionCount", () => {
  test("updates an existing row without mutating it", () => {
    const before = [{ episode: 2, count: 1, latest: [] }];
    const after = updateDiscussionCount(before, 2, 4);
    expect(after).not.toBe(before);
    expect(after[0].count).toBe(4);
    expect(before[0].count).toBe(1);
  });

  test("adds a newly active episode", () => {
    expect(updateDiscussionCount([], 7, 1)).toEqual([{ episode: 7, count: 1, latest: [] }]);
  });

  test("applies mutation deltas without replacing totals with a capped page", () => {
    const rows = [{ episode: 2, count: 700, latest: [] }];
    expect(applyDiscussionDelta(rows, 2, 1)[0].count).toBe(701);
    expect(applyDiscussionDelta(rows, 2, -1)[0].count).toBe(699);
  });
});

describe("deletedCommentCount", () => {
  test("includes descendants removed by the database cascade", () => {
    const rows = [
      { id: "root", parentId: null },
      { id: "reply-1", parentId: "root" },
      { id: "reply-2", parentId: "root" },
      { id: "nested", parentId: "reply-1" },
      { id: "other", parentId: null },
    ];
    expect(deletedCommentCount(rows, "root")).toBe(4);
    expect(deletedCommentCount(rows, "reply-2")).toBe(1);
    expect(deletedCommentCount(rows, "missing")).toBe(0);
  });
});

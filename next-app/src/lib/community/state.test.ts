import { describe, expect, test } from "bun:test";
import {
  appendPage,
  excerpt,
  prependItem,
  removeItem,
  threadRowFrom,
  updateItem,
  withBody,
  withLike,
  withReply,
  withoutReply,
  withVote,
} from "./state";
import type { CommunityActivity, CommunityPage, CommunityReply, CommunityReview } from "./types";

const author = { username: "alice", avatarUrl: null, backdropCoverUrl: null };

const review = (id: string, extra: Partial<CommunityReview> = {}): CommunityReview => ({
  id,
  anilistId: 1,
  author,
  summary: "一句话总结一下这部番",
  body: "正文",
  bodyHidden: false,
  isSpoiler: false,
  isPrivate: false,
  helpfulCount: 0,
  viewerVoted: false,
  isOwn: false,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  ...extra,
});

const page = <T>(items: T[], extra: Partial<CommunityPage<T>> = {}): CommunityPage<T> => ({
  items,
  total: items.length,
  page: 1,
  hasMore: false,
  nextPage: null,
  ...extra,
});

const reply = (id: string): CommunityReply => ({
  id,
  author,
  body: "我也看完了",
  isSpoiler: false,
  parentId: null,
  replyToUsername: null,
  isOwn: true,
  createdAt: "2026-10-01T00:00:00Z",
});

const activity: CommunityActivity = {
  id: "e1",
  anilistId: 1,
  author,
  status: "completed",
  likeCount: 0,
  viewerLiked: false,
  replyCount: 0,
  replies: [],
  isOwn: false,
  createdAt: "2026-10-01T00:00:00Z",
};

describe("list updates never mutate", () => {
  test("updateItem replaces one item and returns a new page", () => {
    const before = page([review("a"), review("b")]);
    const after = updateItem(before, "b", (r) => withVote(r, true, 3));
    expect(after).not.toBe(before);
    expect(after.items[1]).toMatchObject({ viewerVoted: true, helpfulCount: 3 });
    expect(before.items[1].viewerVoted).toBe(false);
    expect(updateItem(before, "missing", (r) => r)).toBe(before);
  });

  test("removeItem drops one and counts it out of the total", () => {
    const after = removeItem(page([review("a"), review("b")], { total: 5 }), "a");
    expect(after.items.map((r) => r.id)).toEqual(["b"]);
    expect(after.total).toBe(4);
  });

  test("prependItem puts a new item first, once", () => {
    const once = prependItem(page([review("a")]), review("b"));
    expect(once.items.map((r) => r.id)).toEqual(["b", "a"]);
    expect(once.total).toBe(2);
    expect(prependItem(once, review("b"))).toBe(once);
  });

  test("appendPage skips what is already shown and takes the new paging", () => {
    const first = page([review("a"), review("b")], { total: 4, hasMore: true, nextPage: 2 });
    const next = page([review("b"), review("c")], { total: 4, page: 2, hasMore: false, nextPage: null });
    const merged = appendPage(first, next);
    expect(merged.items.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(merged.page).toBe(2);
    expect(merged.hasMore).toBe(false);
  });
});

describe("item updates", () => {
  test("likes and replies on an activity", () => {
    expect(withLike(activity, true, 1)).toMatchObject({ viewerLiked: true, likeCount: 1 });
    const replied = withReply(activity, reply("r1"));
    expect(replied.replies).toHaveLength(1);
    expect(replied.replyCount).toBe(1);
    expect(withReply(replied, reply("r1"))).toBe(replied);
    const removed = withoutReply(replied, "r1");
    expect(removed.replies).toEqual([]);
    expect(removed.replyCount).toBe(0);
  });

  test("an opened spoiler review gets its body", () => {
    expect(withBody(review("a", { body: "", bodyHidden: true }), "全文")).toMatchObject({ body: "全文", bodyHidden: false });
  });

  test("a new thread's list row", () => {
    const row = threadRowFrom({
      thread: {
        id: "t1",
        anilistId: 1,
        author,
        title: "第五集讨论",
        body: "第一行\n第二行",
        isSpoiler: false,
        createdAt: "2026-10-01T00:00:00Z",
        lastActivityAt: "2026-10-01T00:00:00Z",
      },
    });
    expect(row).toMatchObject({ id: "t1", excerpt: "第一行 第二行", replyCount: 0, isOwn: true });
    expect(threadRowFrom({ thread: { ...row, body: "结局", isSpoiler: true } }).excerpt).toBe("");
  });

  test("excerpt cuts at 120 characters", () => {
    expect(excerpt("字".repeat(121))).toBe(`${"字".repeat(120)}…`);
    expect(excerpt("短")).toBe("短");
  });
});

import { describe, expect, test } from "bun:test";
import { feedActorTarget, feedItemKey, feedItemTarget, feedItemTime } from "./activityFeedState";
import type { FeedItem } from "@/lib/types";

const legacy: FeedItem = {
  username: "A B",
  anilistId: 1,
  title: "Anime",
  titleChinese: null,
  coverImageUrl: null,
  episode: 3,
  status: "watching",
  lastWatchedAt: "old",
};

describe("feed compatibility helpers", () => {
  test("legacy rows deep-link to the episode", () => {
    expect(feedItemTarget(legacy)).toBe("/anime/1#episode-3");
    expect(feedItemTime(legacy)).toBe("old");
    expect(feedActorTarget(legacy)).toBe("/u/A%20B");
  });

  test("extended events prefer id, createdAt and comment target", () => {
    const event = { ...legacy, id: "e1", createdAt: "new", commentId: "c1", kind: "comment" };
    expect(feedItemKey(event)).toBe("e1");
    expect(feedItemTime(event)).toBe("new");
    expect(feedItemTarget(event)).toBe("/anime/1#episode-3-comment-c1");
  });
});

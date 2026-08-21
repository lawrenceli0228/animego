import { describe, expect, test } from "bun:test";
import {
  markAllNotificationsRead,
  markNotificationRead,
  notificationBadge,
  notificationTarget,
  parseNotificationPage,
  parseUnreadCount,
  type CommunityNotification,
} from "./notificationState";

const reply: CommunityNotification = {
  id: "n1",
  type: "comment_reply",
  actor: { username: "葬送", avatarUrl: null },
  // Carries the full hant channel so the round-trip below proves the parser
  // preserves all three fields rather than dropping them on the floor — the
  // failure mode when a wire field is added to go-api and not to the local
  // shape here is silence, not a type error, because `record()` hands back
  // `Record<string, unknown>`.
  anime: {
    anilistId: 154587,
    title: "Frieren",
    titleChinese: "葬送的芙莉莲",
    titleHant: "葬送的芙莉蓮",
    titleHantSource: "wikipedia",
    titleHantSeo: "葬送的芙莉蓮",
    coverImageUrl: null,
  },
  episode: 8,
  commentId: "c-1",
  excerpt: "same",
  isSpoiler: false,
  createdAt: "2026-08-15T00:00:00Z",
  readAt: null,
};

test("parses standard notification envelopes", () => {
  const raw = { data: { unreadCount: 2, items: [reply, { nope: true }] } };
  expect(parseUnreadCount({ data: { unreadCount: 2 } })).toBe(2);
  expect(parseNotificationPage(raw)).toEqual({ items: [reply], unreadCount: 2 });
});

test("builds community deep links", () => {
  expect(notificationTarget(reply)).toBe("/anime/154587#episode-8-comment-c-1");
  expect(notificationTarget({ ...reply, type: "follow", anime: null })).toBe("/u/%E8%91%AC%E9%80%81");
});

test("formats and reduces unread state", () => {
  expect(notificationBadge(100)).toBe("99+");
  const page = { items: [reply], unreadCount: 1 };
  const one = markNotificationRead(page, "n1", "now");
  expect(one.unreadCount).toBe(0);
  expect(one.items[0].readAt).toBe("now");
  expect(markAllNotificationsRead(page, "all").unreadCount).toBe(0);
});

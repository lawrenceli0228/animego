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
  replyId: null,
  threadId: null,
  threadTitle: null,
  activityId: null,
  excerpt: "same",
  isSpoiler: false,
  createdAt: "2026-08-15T00:00:00Z",
  readAt: null,
  edit: null,
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

// The anime community tab (go-api migration 0046) adds two reply kinds. Each
// carries the reply and where it sits, and lands on that exact place.
const threadReply: CommunityNotification = {
  ...reply,
  id: "n2",
  type: "thread_reply",
  episode: null,
  commentId: null,
  replyId: "r-1",
  threadId: "t-1",
  threadTitle: "第五集的回忆杀",
  activityId: null,
};

const activityReply: CommunityNotification = {
  ...reply,
  id: "n3",
  type: "activity_reply",
  episode: null,
  commentId: null,
  replyId: "r-2",
  threadId: null,
  threadTitle: null,
  activityId: "e-1",
};

test("parses the community reply kinds", () => {
  const raw = { data: { unreadCount: 2, items: [threadReply, activityReply, { ...reply, type: "something_new" }] } };
  expect(parseNotificationPage(raw).items).toEqual([threadReply, activityReply]);
});

test("links a thread reply to the reply on the thread page", () => {
  expect(notificationTarget(threadReply)).toBe("/anime/154587/social/threads/t-1#reply-r-1");
});

test("links an activity reply to the event on the community tab", () => {
  expect(notificationTarget(activityReply)).toBe("/anime/154587/social#activity-e-1");
});

test("a reply notification missing its place falls back to the tab", () => {
  expect(notificationTarget({ ...threadReply, threadId: null })).toBe("/anime/154587/social");
  expect(notificationTarget({ ...activityReply, activityId: null })).toBe("/anime/154587/social");
});

test("an edit_review row: the page, the outcome, the notes, and a link to the page", () => {
  const raw = {
    data: {
      unreadCount: 1,
      items: [
        {
          id: "n2",
          type: "edit_review",
          actor: { username: "admin", avatarUrl: null },
          anime: null,
          episode: null,
          commentId: null,
          excerpt: null,
          isSpoiler: false,
          createdAt: "2026-10-09T00:00:00Z",
          readAt: null,
          edit: {
            kind: "character",
            entityId: 184313,
            snapshot: { name: { full: "Stark", native: "シュタルク", cn: "修塔尔克" }, image: "https://x.org/s.jpg", work: null },
            accepted: 1,
            rejected: 1,
            rejectNotes: ["第二季的造型", 5],
          },
        },
        // An edit_review without its outcome is dropped, not shown blank.
        { id: "n3", type: "edit_review", actor: { username: "admin" }, createdAt: "2026-10-09T00:00:00Z" },
      ],
    },
  };
  const page = parseNotificationPage(raw);
  expect(page.items).toHaveLength(1);
  const [item] = page.items;
  expect(item.edit).toEqual({
    kind: "character",
    entityId: 184313,
    name: { full: "Stark", native: "シュタルク", cn: "修塔尔克" },
    image: "https://x.org/s.jpg",
    accepted: 1,
    rejected: 1,
    rejectNotes: ["第二季的造型"],
  });
  expect(notificationTarget(item)).toBe("/character/184313");
  expect(notificationTarget({ ...item, edit: { ...item.edit!, kind: "person", entityId: 133507 } })).toBe("/person/133507");
});

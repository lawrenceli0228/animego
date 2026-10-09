// Pure updates to the community tab's lists. Every function returns new
// objects and leaves its arguments alone, so a component can hold the result
// in state and React sees a change.

import type {
  CommunityActivity,
  CommunityPage,
  CommunityReply,
  CommunityReview,
  CommunityThreadSummary,
} from "./types";

interface HasId {
  id: string;
}

/** Replace the item with `id` by `update(item)`; untouched if absent. */
export function updateItem<T extends HasId>(page: CommunityPage<T>, id: string, update: (item: T) => T): CommunityPage<T> {
  let changed = false;
  const items = page.items.map((item) => {
    if (item.id !== id) return item;
    changed = true;
    return update(item);
  });
  return changed ? { ...page, items } : page;
}

/** Remove the item with `id`, and count it out of the total. */
export function removeItem<T extends HasId>(page: CommunityPage<T>, id: string): CommunityPage<T> {
  const items = page.items.filter((item) => item.id !== id);
  if (items.length === page.items.length) return page;
  return { ...page, items, total: Math.max(0, page.total - 1) };
}

/** Put a new item first (a thread the reader just started), once. */
export function prependItem<T extends HasId>(page: CommunityPage<T>, item: T): CommunityPage<T> {
  if (page.items.some((existing) => existing.id === item.id)) return page;
  return { ...page, items: [item, ...page.items], total: page.total + 1 };
}

/**
 * Append the next page. Items already shown are skipped: an item can move
 * between pages while the reader is on them (a vote reorders reviews, a reply
 * bumps a thread), and showing it twice is worse than showing it once.
 */
export function appendPage<T extends HasId>(page: CommunityPage<T>, next: CommunityPage<T>): CommunityPage<T> {
  const seen = new Set(page.items.map((item) => item.id));
  return {
    items: [...page.items, ...next.items.filter((item) => !seen.has(item.id))],
    total: next.total,
    page: next.page,
    hasMore: next.hasMore,
    nextPage: next.nextPage,
  };
}

export function withVote(review: CommunityReview, voted: boolean, helpfulCount: number): CommunityReview {
  return { ...review, viewerVoted: voted, helpfulCount };
}

export function withLike(activity: CommunityActivity, liked: boolean, likeCount: number): CommunityActivity {
  return { ...activity, viewerLiked: liked, likeCount };
}

export function withReply(activity: CommunityActivity, reply: CommunityReply): CommunityActivity {
  if (activity.replies.some((r) => r.id === reply.id)) return activity;
  return { ...activity, replies: [...activity.replies, reply], replyCount: activity.replyCount + 1 };
}

export function withoutReply(activity: CommunityActivity, replyId: string): CommunityActivity {
  const replies = activity.replies.filter((r) => r.id !== replyId);
  if (replies.length === activity.replies.length) return activity;
  return { ...activity, replies, replyCount: Math.max(0, activity.replyCount - 1) };
}

/** A review's body arrived (a spoiler review, opened): keep everything else. */
export function withBody(review: CommunityReview, body: string): CommunityReview {
  return { ...review, body, bodyHidden: false };
}

/** The thread list row for a thread the reader just started. */
export function threadRowFrom(view: {
  thread: {
    id: string;
    anilistId: number;
    author: CommunityThreadSummary["author"];
    title: string;
    body: string;
    isSpoiler: boolean;
    createdAt: string;
    lastActivityAt: string;
  };
}): CommunityThreadSummary {
  const t = view.thread;
  return {
    id: t.id,
    anilistId: t.anilistId,
    author: t.author,
    title: t.title,
    excerpt: t.isSpoiler ? "" : excerpt(t.body),
    isSpoiler: t.isSpoiler,
    replyCount: 0,
    isOwn: true,
    createdAt: t.createdAt,
    lastActivityAt: t.lastActivityAt,
  };
}

const EXCERPT_CHARS = 120;

/** One line of text, cut to 120 characters — the server's excerpt rule. */
export function excerpt(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(line);
  return chars.length <= EXCERPT_CHARS ? line : `${chars.slice(0, EXCERPT_CHARS).join("").trim()}…`;
}

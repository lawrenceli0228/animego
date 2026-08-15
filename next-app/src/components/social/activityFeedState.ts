import type { FeedItem } from "@/lib/types";

export function feedItemTime(item: FeedItem): string {
  return item.createdAt || item.lastWatchedAt || "";
}

export function feedItemTarget(item: FeedItem): string {
  if (item.kind?.toLowerCase() === "follow") {
    return `/u/${encodeURIComponent(item.targetUsername || item.username)}`;
  }
  const base = `/anime/${item.anilistId}`;
  if (!item.episode || item.episode <= 0) return base;
  const comment = item.commentId ? `-comment-${item.commentId}` : "";
  return `${base}#episode-${item.episode}${comment}`;
}

export function feedActorTarget(item: FeedItem): string {
  return `/u/${encodeURIComponent(item.username)}`;
}

export function feedItemKey(item: FeedItem): string {
  return item.id || `${item.username}-${item.anilistId}-${feedItemTime(item)}`;
}

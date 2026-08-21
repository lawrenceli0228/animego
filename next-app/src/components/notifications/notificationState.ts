export type NotificationType =
  | "comment_reply"
  | "comment_reaction"
  | "follow";

export interface CommunityNotification {
  id: string;
  type: NotificationType;
  actor: { username: string; avatarUrl: string | null };
  // Declares its own anime shape rather than importing lib/types.ts, because
  // this is the parsed/validated result of `notification()` below and not the
  // raw wire row — `title` is non-null here and nullable on the wire. That
  // means the hant channel go-api added in migration 0022 has to be repeated
  // here by hand; see the channel note in lib/types.ts for what the three
  // fields mean and why titleHantSeo is the only one a <title> may read.
  anime: {
    anilistId: number;
    title: string;
    titleChinese: string | null;
    titleHant: string | null;
    titleHantSource: string | null;
    /** SERP-safe projection — see the hant channel note in lib/types.ts. */
    titleHantSeo: string | null;
    coverImageUrl: string | null;
  } | null;
  episode: number | null;
  commentId: string | null;
  excerpt: string | null;
  isSpoiler: boolean;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationPage {
  items: CommunityNotification[];
  unreadCount: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function nonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;
}

function notification(value: unknown): CommunityNotification | null {
  const row = record(value);
  const actor = record(row?.actor);
  const anime = record(row?.anime);
  const id = string(row?.id);
  const type = string(row?.type);
  const username = string(actor?.username);
  const createdAt = string(row?.createdAt);
  if (
    !id ||
    !username ||
    !createdAt ||
    !["comment_reply", "comment_reaction", "follow"].includes(type ?? "")
  ) {
    return null;
  }
  const anilistId = anime?.anilistId;
  return {
    id,
    type: type as NotificationType,
    actor: { username, avatarUrl: string(actor?.avatarUrl) },
    anime:
      typeof anilistId === "number" && Number.isSafeInteger(anilistId) && anilistId > 0
        ? {
            anilistId,
            title: string(anime?.title) ?? `Anime #${anilistId}`,
            titleChinese: string(anime?.titleChinese),
            titleHant: string(anime?.titleHant),
            titleHantSource: string(anime?.titleHantSource),
            titleHantSeo: string(anime?.titleHantSeo),
            coverImageUrl: string(anime?.coverImageUrl),
          }
        : null,
    episode:
      typeof row?.episode === "number" && Number.isSafeInteger(row.episode) && row.episode > 0
        ? row.episode
        : null,
    commentId: string(row?.commentId),
    excerpt: string(row?.excerpt),
    isSpoiler: row?.isSpoiler === true,
    createdAt,
    readAt: string(row?.readAt),
  };
}

export function parseUnreadCount(value: unknown): number {
  const root = record(value);
  const data = record(root?.data);
  return nonNegativeInt(data?.unreadCount);
}

export function parseNotificationPage(value: unknown): NotificationPage {
  const root = record(value);
  const data = record(root?.data);
  const rows = Array.isArray(data?.items) ? data.items : [];
  return {
    items: rows.map(notification).filter((item): item is CommunityNotification => item !== null),
    unreadCount: nonNegativeInt(data?.unreadCount),
  };
}

export function notificationBadge(count: number): string {
  if (count <= 0) return "";
  return count > 99 ? "99+" : String(count);
}

export function notificationTarget(item: CommunityNotification): string {
  if (item.type === "follow" || !item.anime) {
    return `/u/${encodeURIComponent(item.actor.username)}`;
  }
  const base = `/anime/${item.anime.anilistId}`;
  if (!item.episode) return base;
  const comment = item.commentId ? `-comment-${item.commentId}` : "";
  return `${base}#episode-${item.episode}${comment}`;
}

export function markNotificationRead(
  page: NotificationPage,
  id: string,
  readAt: string,
): NotificationPage {
  let changed = false;
  const items = page.items.map((item) => {
    if (item.id !== id || item.readAt) return item;
    changed = true;
    return { ...item, readAt };
  });
  if (!changed) return page;
  return { items, unreadCount: Math.max(0, page.unreadCount - 1) };
}

export function markAllNotificationsRead(
  page: NotificationPage,
  readAt: string,
): NotificationPage {
  if (page.unreadCount === 0 && page.items.every((item) => item.readAt)) return page;
  return {
    unreadCount: 0,
    items: page.items.map((item) => (item.readAt ? item : { ...item, readAt })),
  };
}

export interface DiscussionPreview {
  id: string;
  userId: string;
  username: string;
  avatarUrl: string | null;
  backdropCoverUrl: string | null;
  content: string;
  isSpoiler: boolean;
  createdAt: string;
}

export interface EpisodeDiscussionSummary {
  episode: number;
  count: number;
  latest: DiscussionPreview[];
}

export interface DiscussionHashTarget {
  episode: number;
  commentId: string | null;
}

export const DISCUSSION_NAVIGATION_EVENT = "animego:discussion-navigation";

const COMMENT_ID = /^[A-Za-z0-9-]+$/;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function preview(value: unknown): DiscussionPreview | null {
  const row = record(value);
  if (!row) return null;
  const id = nullableString(row.id);
  const userId = nullableString(row.userId);
  const username = nullableString(row.username);
  const isSpoiler = row.isSpoiler === true;
  const content = nullableString(row.content);
  const createdAt = nullableString(row.createdAt);
  if (!id || !userId || !username || (!content && !isSpoiler) || !createdAt) return null;
  return {
    id,
    userId,
    username,
    avatarUrl: nullableString(row.avatarUrl),
    backdropCoverUrl: nullableString(row.backdropCoverUrl),
    content: content ?? "",
    isSpoiler,
    createdAt,
  };
}

/** Parse the standard `{data:[...]}` summary envelope defensively. */
export function parseEpisodeDiscussionSummary(
  value: unknown,
): EpisodeDiscussionSummary[] {
  const root = record(value);
  const rows = Array.isArray(root?.data)
    ? root.data
    : Array.isArray(value)
      ? value
      : [];
  const byEpisode = new Map<number, EpisodeDiscussionSummary>();
  for (const value of rows) {
    const row = record(value);
    const episode = row?.episode;
    const count = row?.count;
    if (
      typeof episode !== "number" ||
      !Number.isInteger(episode) ||
      episode <= 0 ||
      typeof count !== "number" ||
      !Number.isInteger(count) ||
      count < 0
    ) {
      continue;
    }
    const latest = Array.isArray(row.latest)
      ? row.latest.map(preview).filter((item): item is DiscussionPreview => item !== null).slice(0, 2)
      : [];
    byEpisode.set(episode, { episode, count, latest });
  }
  return [...byEpisode.values()].sort((a, b) => a.episode - b.episode);
}

export function parseDiscussionHash(hash: string): DiscussionHashTarget | null {
  const match = hash.match(/^#episode-(\d+)(?:-comment-(.+))?$/);
  if (!match) return null;
  const episode = Number(match[1]);
  let commentId: string | null = null;
  if (match[2]) {
    try {
      commentId = decodeURIComponent(match[2]);
    } catch {
      return null;
    }
  }
  if (!Number.isSafeInteger(episode) || episode <= 0) return null;
  if (commentId && !COMMENT_ID.test(commentId)) return null;
  return { episode, commentId };
}

/** Resolve only same-page discussion hrefs; other anime must not open this grid. */
export function discussionTargetFromHref(
  href: string,
  currentPathname: string,
): DiscussionHashTarget | null {
  try {
    const url = new URL(href, "https://animego.invalid");
    if (url.pathname !== currentPathname) return null;
    return parseDiscussionHash(url.hash);
  } catch {
    return null;
  }
}

/** Tell an already-mounted episode grid about a Next Link hash navigation. */
export function dispatchDiscussionNavigation(href: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(DISCUSSION_NAVIGATION_EVENT, { detail: { href } }),
  );
}

export function discussionHash(episode: number, commentId?: string | null): string {
  if (!Number.isSafeInteger(episode) || episode <= 0) return "";
  if (commentId && COMMENT_ID.test(commentId)) {
    return `#episode-${episode}-comment-${commentId}`;
  }
  return `#episode-${episode}`;
}

export function updateDiscussionCount(
  rows: EpisodeDiscussionSummary[],
  episode: number,
  count: number,
): EpisodeDiscussionSummary[] {
  if (!Number.isSafeInteger(episode) || episode <= 0 || count < 0) return rows;
  const index = rows.findIndex((row) => row.episode === episode);
  if (index === -1) {
    if (count === 0) return rows;
    return [...rows, { episode, count, latest: [] }].sort(
      (a, b) => a.episode - b.episode,
    );
  }
  if (rows[index].count === count) return rows;
  const next = [...rows];
  next[index] = { ...next[index], count };
  return next;
}

export function applyDiscussionDelta(
  rows: EpisodeDiscussionSummary[],
  episode: number,
  delta: number,
): EpisodeDiscussionSummary[] {
  if (!Number.isInteger(delta) || delta === 0) return rows;
  const current = rows.find((row) => row.episode === episode)?.count ?? 0;
  return updateDiscussionCount(rows, episode, Math.max(0, current + delta));
}

/** Count the visible subtree removed by the comments table's ON DELETE CASCADE. */
export function deletedCommentCount(
  rows: ReadonlyArray<{ id: string; parentId: string | null }>,
  rootId: string,
): number {
  const pending = [rootId];
  const deleted = new Set<string>();
  while (pending.length > 0) {
    const id = pending.pop() as string;
    if (deleted.has(id)) continue;
    const exists = rows.some((row) => row.id === id);
    if (!exists) continue;
    deleted.add(id);
    for (const row of rows) {
      if (row.parentId === id) pending.push(row.id);
    }
  }
  return deleted.size;
}

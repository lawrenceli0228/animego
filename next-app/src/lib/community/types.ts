// The community tab's wire shapes (go-api internal/community), and the
// parsers that turn an untrusted response body into them.
//
// Parsed rather than cast. The summary is server-rendered into a cached page
// and re-read by the client after load; a field renamed on one side must
// degrade to "that item is missing", not to a crash in the render or to
// `undefined` printed into the page. Same approach as
// components/notifications/notificationState.ts.

export type SubscriptionStatus = "watching" | "completed" | "plan_to_watch" | "dropped";

export const SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  "watching",
  "completed",
  "plan_to_watch",
  "dropped",
];

export interface CommunityAuthor {
  username: string;
  avatarUrl: string | null;
  backdropCoverUrl: string | null;
}

export interface CommunityPage<T> {
  items: T[];
  total: number;
  page: number;
  hasMore: boolean;
  nextPage: number | null;
}

export interface CommunityReview {
  id: string;
  anilistId: number;
  author: CommunityAuthor;
  summary: string;
  /** Empty when `bodyHidden`: the list withholds a spoiler review's body. */
  body: string;
  bodyHidden: boolean;
  isSpoiler: boolean;
  isPrivate: boolean;
  helpfulCount: number;
  viewerVoted: boolean;
  isOwn: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CommunityReply {
  id: string;
  author: CommunityAuthor;
  body: string;
  isSpoiler: boolean;
  parentId: string | null;
  replyToUsername: string | null;
  isOwn: boolean;
  createdAt: string;
}

export interface CommunityThreadSummary {
  id: string;
  anilistId: number;
  author: CommunityAuthor;
  title: string;
  /** One line of the body; empty for a spoiler thread. */
  excerpt: string;
  isSpoiler: boolean;
  replyCount: number;
  isOwn: boolean;
  createdAt: string;
  lastActivityAt: string;
}

export interface CommunityThread {
  id: string;
  anilistId: number;
  author: CommunityAuthor;
  title: string;
  body: string;
  isSpoiler: boolean;
  isOwn: boolean;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
}

export interface CommunityThreadView {
  thread: CommunityThread;
  replies: CommunityReply[];
}

export interface CommunityActivity {
  id: string;
  anilistId: number;
  author: CommunityAuthor;
  status: SubscriptionStatus;
  likeCount: number;
  viewerLiked: boolean;
  replyCount: number;
  replies: CommunityReply[];
  isOwn: boolean;
  createdAt: string;
}

export interface CommunityWatcher {
  username: string;
  avatarUrl: string | null;
  backdropCoverUrl: string | null;
  status: SubscriptionStatus;
  currentEpisode: number;
  since: string;
}

export interface WatcherCounts {
  watching: number;
  completed: number;
  planToWatch: number;
  dropped: number;
}

export interface CommunityWatchers {
  items: CommunityWatcher[];
  total: number;
  counts: WatcherCounts;
}

export interface CommunityViewer {
  status: SubscriptionStatus | null;
  reviewId: string | null;
}

export interface CommunitySummary {
  reviews: CommunityPage<CommunityReview>;
  threads: CommunityPage<CommunityThreadSummary>;
  activity: CommunityPage<CommunityActivity>;
  watchers: CommunityWatchers;
  /** Present only on a signed-in read. */
  viewer: CommunityViewer | null;
}

// ── primitives ──────────────────────────────────────────────────────────

type Raw = Record<string, unknown>;

function record(value: unknown): Raw | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function bool(value: unknown): boolean {
  return value === true;
}

function list<T>(value: unknown, parse: (item: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  return value.map(parse).filter((item): item is T => item !== null);
}

function status(value: unknown): SubscriptionStatus | null {
  return SUBSCRIPTION_STATUSES.includes(value as SubscriptionStatus) ? (value as SubscriptionStatus) : null;
}

// ── item parsers ────────────────────────────────────────────────────────

export function parseAuthor(value: unknown): CommunityAuthor | null {
  const row = record(value);
  const username = nonEmpty(row?.username);
  if (!row || !username) return null;
  return {
    username,
    avatarUrl: nonEmpty(row.avatarUrl),
    backdropCoverUrl: nonEmpty(row.backdropCoverUrl),
  };
}

export function parseReview(value: unknown): CommunityReview | null {
  const row = record(value);
  const id = nonEmpty(row?.id);
  const author = parseAuthor(row?.author);
  const summary = nonEmpty(row?.summary);
  const createdAt = nonEmpty(row?.createdAt);
  if (!row || !id || !author || !summary || !createdAt) return null;
  return {
    id,
    anilistId: count(row.anilistId),
    author,
    summary,
    body: str(row.body) ?? "",
    bodyHidden: bool(row.bodyHidden),
    isSpoiler: bool(row.isSpoiler),
    isPrivate: bool(row.isPrivate),
    helpfulCount: count(row.helpfulCount),
    viewerVoted: bool(row.viewerVoted),
    isOwn: bool(row.isOwn),
    createdAt,
    updatedAt: nonEmpty(row.updatedAt) ?? createdAt,
  };
}

export function parseReply(value: unknown): CommunityReply | null {
  const row = record(value);
  const id = nonEmpty(row?.id);
  const author = parseAuthor(row?.author);
  const body = nonEmpty(row?.body);
  const createdAt = nonEmpty(row?.createdAt);
  if (!row || !id || !author || !body || !createdAt) return null;
  return {
    id,
    author,
    body,
    isSpoiler: bool(row.isSpoiler),
    parentId: nonEmpty(row.parentId),
    replyToUsername: nonEmpty(row.replyToUsername),
    isOwn: bool(row.isOwn),
    createdAt,
  };
}

export function parseThreadSummary(value: unknown): CommunityThreadSummary | null {
  const row = record(value);
  const id = nonEmpty(row?.id);
  const author = parseAuthor(row?.author);
  const title = nonEmpty(row?.title);
  const createdAt = nonEmpty(row?.createdAt);
  if (!row || !id || !author || !title || !createdAt) return null;
  return {
    id,
    anilistId: count(row.anilistId),
    author,
    title,
    excerpt: str(row.excerpt) ?? "",
    isSpoiler: bool(row.isSpoiler),
    replyCount: count(row.replyCount),
    isOwn: bool(row.isOwn),
    createdAt,
    lastActivityAt: nonEmpty(row.lastActivityAt) ?? createdAt,
  };
}

export function parseThread(value: unknown): CommunityThread | null {
  const row = record(value);
  const id = nonEmpty(row?.id);
  const author = parseAuthor(row?.author);
  const title = nonEmpty(row?.title);
  const body = nonEmpty(row?.body);
  const createdAt = nonEmpty(row?.createdAt);
  if (!row || !id || !author || !title || !body || !createdAt) return null;
  return {
    id,
    anilistId: count(row.anilistId),
    author,
    title,
    body,
    isSpoiler: bool(row.isSpoiler),
    isOwn: bool(row.isOwn),
    createdAt,
    updatedAt: nonEmpty(row.updatedAt) ?? createdAt,
    lastActivityAt: nonEmpty(row.lastActivityAt) ?? createdAt,
  };
}

export function parseThreadView(value: unknown): CommunityThreadView | null {
  const row = record(value);
  const thread = parseThread(row?.thread);
  if (!row || !thread) return null;
  return { thread, replies: list(row.replies, parseReply) };
}

export function parseActivity(value: unknown): CommunityActivity | null {
  const row = record(value);
  const id = nonEmpty(row?.id);
  const author = parseAuthor(row?.author);
  const s = status(row?.status);
  const createdAt = nonEmpty(row?.createdAt);
  if (!row || !id || !author || !s || !createdAt) return null;
  return {
    id,
    anilistId: count(row.anilistId),
    author,
    status: s,
    likeCount: count(row.likeCount),
    viewerLiked: bool(row.viewerLiked),
    replyCount: count(row.replyCount),
    replies: list(row.replies, parseReply),
    isOwn: bool(row.isOwn),
    createdAt,
  };
}

function parseWatcher(value: unknown): CommunityWatcher | null {
  const row = record(value);
  const username = nonEmpty(row?.username);
  const s = status(row?.status);
  const since = nonEmpty(row?.since);
  if (!row || !username || !s || !since) return null;
  return {
    username,
    avatarUrl: nonEmpty(row.avatarUrl),
    backdropCoverUrl: nonEmpty(row.backdropCoverUrl),
    status: s,
    currentEpisode: count(row.currentEpisode),
    since,
  };
}

export function parseWatchers(value: unknown): CommunityWatchers {
  const row = record(value);
  const counts = record(row?.counts);
  return {
    items: list(row?.items, parseWatcher),
    total: count(row?.total),
    counts: {
      watching: count(counts?.watching),
      completed: count(counts?.completed),
      planToWatch: count(counts?.planToWatch),
      dropped: count(counts?.dropped),
    },
  };
}

export function parsePage<T>(value: unknown, parse: (item: unknown) => T | null): CommunityPage<T> {
  const row = record(value);
  const items = list(row?.items, parse);
  const next = row?.nextPage;
  return {
    items,
    total: Math.max(count(row?.total), items.length),
    page: Math.max(1, count(row?.page)),
    hasMore: bool(row?.hasMore),
    nextPage: typeof next === "number" && Number.isInteger(next) && next > 1 ? next : null,
  };
}

function parseViewer(value: unknown): CommunityViewer | null {
  const row = record(value);
  if (!row) return null;
  return { status: status(row.status), reviewId: nonEmpty(row.reviewId) };
}

/** The summary from GET /api/anime/{id}/community's `data`, or null. */
export function parseSummary(value: unknown): CommunitySummary | null {
  const row = record(value);
  if (!row) return null;
  return {
    reviews: parsePage(row.reviews, parseReview),
    threads: parsePage(row.threads, parseThreadSummary),
    activity: parsePage(row.activity, parseActivity),
    watchers: parseWatchers(row.watchers),
    viewer: parseViewer(row.viewer),
  };
}

export function emptyPage<T>(): CommunityPage<T> {
  return { items: [], total: 0, page: 1, hasMore: false, nextPage: null };
}

export function emptySummary(): CommunitySummary {
  return {
    reviews: emptyPage(),
    threads: emptyPage(),
    activity: emptyPage(),
    watchers: { items: [], total: 0, counts: { watching: 0, completed: 0, planToWatch: 0, dropped: 0 } },
    viewer: null,
  };
}

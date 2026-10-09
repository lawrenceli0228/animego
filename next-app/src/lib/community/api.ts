// Client calls to the community tab's endpoints (go-api internal/community).
//
// Every call goes through authFetch, so a stale access token is refreshed
// once and retried; reads pass skipRedirectOnFailure because an anonymous
// reader is a normal reader here, not an expired session. Every response is
// parsed (see ./types) rather than cast.

import { authFetch } from "@/lib/authFetch";
import type { SubscriptionDoc } from "@/lib/subscriptionBus";
import {
  parseActivity,
  parsePage,
  parseReply,
  parseReview,
  parseSummary,
  parseThreadSummary,
  parseThreadView,
  parseWatchers,
  SUBSCRIPTION_STATUSES,
  type SubscriptionStatus,
  type CommunityActivity,
  type CommunityPage,
  type CommunityReply,
  type CommunityReview,
  type CommunitySummary,
  type CommunityThreadSummary,
  type CommunityThreadView,
  type CommunityWatchers,
} from "./types";

export interface ApiFailure {
  ok: false;
  status: number;
  code: string;
  message: string;
}

export type ApiResult<T> = { ok: true; data: T } | ApiFailure;

const PAGE_SIZE = 10;

function base(anilistId: number): string {
  return `/api/anime/${anilistId}/community`;
}

function failed<T>(status: number, code = "", message = ""): ApiResult<T> {
  return { ok: false, status, code, message };
}

async function call<T>(
  path: string,
  init: RequestInit & { skipRedirectOnFailure?: boolean },
  parse: (data: unknown) => T | null,
): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await authFetch(path, init);
  } catch {
    return failed(0, "NETWORK_ERROR");
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* an empty or non-JSON body; handled below */
  }
  const env = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  if (!res.ok) {
    const error = env?.error && typeof env.error === "object" ? (env.error as Record<string, unknown>) : null;
    return failed(
      res.status,
      typeof error?.code === "string" ? error.code : "",
      typeof error?.message === "string" ? error.message : "",
    );
  }
  const data = parse(env?.data);
  return data === null ? failed(res.status, "INVALID_RESPONSE") : { ok: true, data };
}

function read<T>(path: string, parse: (data: unknown) => T | null): Promise<ApiResult<T>> {
  return call(path, { skipRedirectOnFailure: true, cache: "no-store" }, parse);
}

function write<T>(method: string, path: string, body: unknown, parse: (data: unknown) => T | null): Promise<ApiResult<T>> {
  return call(
    path,
    {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    parse,
  );
}

function record(data: unknown): Record<string, unknown> | null {
  return data && typeof data === "object" ? (data as Record<string, unknown>) : null;
}

function counted(key: "helpfulCount" | "likeCount") {
  return (data: unknown): number | null => {
    const value = record(data)?.[key];
    return typeof value === "number" && value >= 0 ? value : null;
  };
}

function deleted(data: unknown): true | null {
  return record(data)?.deleted === true ? true : null;
}

// ── reads ────────────────────────────────────────────────────────────────

export function fetchSummary(anilistId: number): Promise<ApiResult<CommunitySummary>> {
  return read(base(anilistId), parseSummary);
}

export function fetchReviews(anilistId: number, page: number): Promise<ApiResult<CommunityPage<CommunityReview>>> {
  return read(`${base(anilistId)}/reviews?page=${page}&limit=${PAGE_SIZE}`, (d) => parsePage(d, parseReview));
}

export function fetchReview(anilistId: number, reviewId: string): Promise<ApiResult<CommunityReview>> {
  return read(`${base(anilistId)}/reviews/${encodeURIComponent(reviewId)}`, parseReview);
}

export function fetchMyReview(anilistId: number): Promise<ApiResult<CommunityReview>> {
  return read(`${base(anilistId)}/reviews/mine`, parseReview);
}

export function fetchThreads(anilistId: number, page: number): Promise<ApiResult<CommunityPage<CommunityThreadSummary>>> {
  return read(`${base(anilistId)}/threads?page=${page}&limit=${PAGE_SIZE}`, (d) => parsePage(d, parseThreadSummary));
}

export function fetchThread(anilistId: number, threadId: string): Promise<ApiResult<CommunityThreadView>> {
  return read(`${base(anilistId)}/threads/${encodeURIComponent(threadId)}`, parseThreadView);
}

export function fetchActivity(anilistId: number, page: number): Promise<ApiResult<CommunityPage<CommunityActivity>>> {
  return read(`${base(anilistId)}/activity?page=${page}&limit=${PAGE_SIZE}`, (d) => parsePage(d, parseActivity));
}

export function fetchActivityEvent(anilistId: number, eventId: string): Promise<ApiResult<CommunityActivity>> {
  return read(`${base(anilistId)}/activity/${encodeURIComponent(eventId)}`, parseActivity);
}

export function fetchWatchers(anilistId: number): Promise<ApiResult<CommunityWatchers>> {
  return read(`${base(anilistId)}/watchers`, parseWatchers);
}

// ── writes ───────────────────────────────────────────────────────────────

export interface ReviewInput {
  summary: string;
  body: string;
  isSpoiler: boolean;
  isPrivate: boolean;
}

export function createReview(anilistId: number, input: ReviewInput): Promise<ApiResult<CommunityReview>> {
  return write("POST", `${base(anilistId)}/reviews`, input, parseReview);
}

export function updateReview(anilistId: number, reviewId: string, input: ReviewInput): Promise<ApiResult<CommunityReview>> {
  return write("PATCH", `${base(anilistId)}/reviews/${encodeURIComponent(reviewId)}`, input, parseReview);
}

export function deleteReview(anilistId: number, reviewId: string): Promise<ApiResult<true>> {
  return write("DELETE", `${base(anilistId)}/reviews/${encodeURIComponent(reviewId)}`, undefined, deleted);
}

export function setHelpful(anilistId: number, reviewId: string, voted: boolean): Promise<ApiResult<number>> {
  return write(
    voted ? "PUT" : "DELETE",
    `${base(anilistId)}/reviews/${encodeURIComponent(reviewId)}/helpful`,
    undefined,
    counted("helpfulCount"),
  );
}

export interface ThreadInput {
  title: string;
  body: string;
  isSpoiler: boolean;
}

export function createThread(anilistId: number, input: ThreadInput): Promise<ApiResult<CommunityThreadView>> {
  return write("POST", `${base(anilistId)}/threads`, input, parseThreadView);
}

export function deleteThread(anilistId: number, threadId: string): Promise<ApiResult<true>> {
  return write("DELETE", `${base(anilistId)}/threads/${encodeURIComponent(threadId)}`, undefined, deleted);
}

export interface ReplyInput {
  body: string;
  isSpoiler?: boolean;
  parentId?: string | null;
}

export function createThreadReply(anilistId: number, threadId: string, input: ReplyInput): Promise<ApiResult<CommunityReply>> {
  return write("POST", `${base(anilistId)}/threads/${encodeURIComponent(threadId)}/replies`, input, parseReply);
}

export function createActivityReply(anilistId: number, eventId: string, input: ReplyInput): Promise<ApiResult<CommunityReply>> {
  return write("POST", `${base(anilistId)}/activity/${encodeURIComponent(eventId)}/replies`, input, parseReply);
}

export function setLike(anilistId: number, eventId: string, liked: boolean): Promise<ApiResult<number>> {
  return write(
    liked ? "PUT" : "DELETE",
    `${base(anilistId)}/activity/${encodeURIComponent(eventId)}/like`,
    undefined,
    counted("likeCount"),
  );
}

export function deleteReply(anilistId: number, replyId: string): Promise<ApiResult<true>> {
  return write("DELETE", `${base(anilistId)}/replies/${encodeURIComponent(replyId)}`, undefined, deleted);
}

/** The subscription row POST /api/subscriptions answers with, as the bus carries it. */
function parseSubscription(data: unknown): SubscriptionDoc | null {
  const row = record(data);
  const status = row?.status;
  if (!row || !SUBSCRIPTION_STATUSES.includes(status as SubscriptionStatus)) return null;
  const episode = row.currentEpisode;
  const score = row.score;
  return {
    status: status as SubscriptionStatus,
    currentEpisode: typeof episode === "number" && episode >= 0 ? episode : 0,
    score: typeof score === "number" ? score : null,
  };
}

/**
 * Add the anime to the reader's list as 在看 — the 谁在追 card's button.
 * ifAbsent: a title already on the list keeps the status its owner chose.
 */
export function followAnime(anilistId: number): Promise<ApiResult<SubscriptionDoc>> {
  return call(
    "/api/subscriptions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ anilistId, status: "watching", ifAbsent: true }),
    },
    parseSubscription,
  );
}

// ── errors ───────────────────────────────────────────────────────────────

/**
 * The dictionary key for a failed call — the page says it in its own words.
 *
 * Takes the whole result rather than the failure half: this project compiles
 * without strictNullChecks, where `if (!result.ok)` does not narrow the union,
 * so callers hand over what they have and this reads it.
 */
export function errorKey(result: ApiResult<unknown>): string {
  const status = result.ok ? 0 : (result as ApiFailure).status;
  if (status === 401) return "community.errorLogin";
  if (status === 403) return "community.errorBlocked";
  if (status === 404) return "community.errorGone";
  if (status === 409) return "community.errorAlreadyReviewed";
  if (status === 429) return "community.errorTooMany";
  if (status === 400) return "community.errorInvalid";
  return "community.errorFailed";
}

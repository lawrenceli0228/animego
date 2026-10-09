"use client";

// The 社区 tab's body: 评价, 讨论帖 and 最近动态 in the main column, 谁在追
// beside them (below them on a phone).
//
// ## Who sees what, and when
//
// The page is ISR and edge-cached, so what the server renders is one
// anonymous read for everybody: public reviews, threads and activity, no
// private review, no "you voted". That render is `initial`. Everything that
// differs per reader is fetched here, after load, with the reader's session:
// when the auth_hint cookie says there is one, the whole summary is read again
// and replaces `initial` — adding the reader's private review, their votes
// and likes, whether each thing is theirs, and their own status for 谁在追.
// A like or reply made before that read answers is not undone by it
// (lib/community/freshRead.ts). An anonymous reader costs no request at all. If the server render could not
// read the community (`initial` is null), the client reads it either way.
//
// Nothing in this file reads a cookie during render; see the route note in
// app/[lang]/anime/[id]/social/page.tsx for why that matters.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { authHrefWithFrom } from "@/components/auth/authFromLink";
import { useLang } from "@/lib/lang-client";
import type { Lang } from "@/lib/i18n/lang";
import { hasAuthHint } from "@/lib/clientAuth";
import { broadcastSubscription } from "@/lib/subscriptionBus";
import { DISCUSSION_NAVIGATION_EVENT } from "@/components/anime/episodeDiscussionState";
import {
  createActivityReply,
  createThread,
  deleteReply,
  deleteReview,
  errorKey,
  fetchActivity,
  fetchActivityEvent,
  fetchReview,
  fetchReviews,
  fetchSummary,
  fetchThreads,
  fetchWatchers,
  followAnime,
  setHelpful,
  setLike,
  type ApiResult,
  type ThreadInput,
} from "@/lib/community/api";
import { freshRead } from "@/lib/community/freshRead";
import { notify } from "@/lib/community/notify";
import {
  appendPage,
  prependItem,
  removeItem,
  threadRowFrom,
  updateItem,
  withBody,
  withLike,
  withoutReply,
  withReply,
  withVote,
} from "@/lib/community/state";
import { emptySummary, type CommunityActivity, type CommunityReply, type CommunityReview, type CommunitySummary } from "@/lib/community/types";
import { useViewer } from "@/lib/community/useViewer";
import ActivitySection from "./ActivitySection";
import ReviewsSection from "./ReviewsSection";
import ThreadsSection from "./ThreadsSection";
import WatchersCard from "./WatchersCard";
import s from "./community.module.css";

const ACTIVITY_HASH = /^#activity-([0-9a-f-]{36})$/i;

export interface SocialTabProps {
  anilistId: number;
  /** The anime's title in the page's language, for "看完了《…》". */
  animeTitle: string;
  coverUrl: string | null;
  /** The anonymous server render's data, or null when it could not be read. */
  initial: CommunitySummary | null;
  /** When the server rendered — the clock dates are written against. */
  renderedAt: string;
  lang: Lang;
}

export default function SocialTab({ anilistId, animeTitle, coverUrl, initial, renderedAt, lang }: SocialTabProps) {
  const { t } = useLang();
  const pathname = usePathname();
  const { viewer, probing } = useViewer();
  const [summary, setSummary] = useState<CommunitySummary>(() => initial ?? emptySummary());
  const [status, setStatus] = useState<"ready" | "loading" | "error">(initial ? "ready" : "loading");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyReplyId, setBusyReplyId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [posting, setPosting] = useState(false);
  const [following, setFollowing] = useState(false);
  const [loadingMore, setLoadingMore] = useState<"reviews" | "threads" | "activity" | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  // The per-reader read below has answered (or was never needed).
  const [readSettled, setReadSettled] = useState(false);
  // Writes applied so far; see lib/community/freshRead.ts.
  const writes = useRef(0);

  const nowMs = useMemo(() => {
    const ms = Date.parse(renderedAt);
    return Number.isFinite(ms) ? ms : 0;
  }, [renderedAt]);
  // Signed in, or still finding out: a reader with the auth hint is shown the
  // signed-in controls from the start rather than a login link that flips.
  const canAct = viewer !== null || probing;
  const loginHref = authHrefWithFrom("/login", pathname);
  const writeHref = `/anime/${anilistId}/social/review`;
  const me = viewer
    ? { username: viewer.username, avatarUrl: viewer.avatarUrl, backdropCoverUrl: viewer.backdropCoverUrl }
    : null;

  const fail = useCallback((result: ApiResult<unknown>) => notify("error", t(errorKey(result))), [t]);

  // Every write's answer goes through here, so a read in flight knows.
  const applyWrite = useCallback((update: (current: CommunitySummary) => CommunitySummary) => {
    writes.current += 1;
    setSummary(update);
  }, []);

  const reload = useCallback(async () => {
    const result = await freshRead(writes, () => fetchSummary(anilistId));
    if (!result) return;
    if (result.ok) {
      setSummary(result.data);
      setStatus("ready");
    } else {
      setStatus((current) => (current === "loading" ? "error" : current));
    }
  }, [anilistId]);

  // The per-reader read (see the file header).
  useEffect(() => {
    const needed = !initial || hasAuthHint();
    const timer = window.setTimeout(() => {
      if (needed) void reload().finally(() => setReadSettled(true));
      else setReadSettled(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [initial, reload]);

  // A notification about a reply lands on #activity-<id>. The event may be
  // past the first page, so it is fetched and shown first when it is not on
  // screen. Three ways to arrive: a full load with the hash, a hash change,
  // and the notification bell's same-page navigation, which goes through
  // history.pushState (no hashchange) and announces itself with the event the
  // episode grid listens for. It waits for the per-reader read, which replaces
  // the activity list and would drop an event fetched in from a later page.
  useEffect(() => {
    if (status !== "ready" || !readSettled) return;
    let cancelled = false;
    const land = async (hash: string) => {
      const match = ACTIVITY_HASH.exec(hash);
      if (!match) return;
      const id = match[1];
      if (!document.getElementById(`activity-${id}`)) {
        const result = await fetchActivityEvent(anilistId, id);
        if (cancelled || !result.ok) return;
        setSummary((current) => ({
          ...current,
          activity: { ...current.activity, items: [result.data, ...current.activity.items.filter((i) => i.id !== id)] },
        }));
      }
      setHighlightId(id);
      window.requestAnimationFrame(() => document.getElementById(`activity-${id}`)?.scrollIntoView({ block: "center" }));
    };
    const fromLocation = () => void land(window.location.hash);
    const fromBell = (event: Event) => {
      const href = (event as CustomEvent<{ href?: string }>).detail?.href ?? "";
      const at = href.indexOf("#");
      if (at >= 0 && href.slice(0, at).endsWith(`/anime/${anilistId}/social`)) void land(href.slice(at));
    };
    fromLocation();
    window.addEventListener("hashchange", fromLocation);
    window.addEventListener(DISCUSSION_NAVIGATION_EVENT, fromBell);
    return () => {
      cancelled = true;
      window.removeEventListener("hashchange", fromLocation);
      window.removeEventListener(DISCUSSION_NAVIGATION_EVENT, fromBell);
    };
  }, [status, readSettled, anilistId]);

  // ── reviews ──────────────────────────────────────────────────────────

  const toggleHelpful = async (review: CommunityReview) => {
    setBusyId(review.id);
    const result = await setHelpful(anilistId, review.id, !review.viewerVoted);
    setBusyId(null);
    if (!result.ok) return fail(result);
    applyWrite((cur) => ({
      ...cur,
      reviews: updateItem(cur.reviews, review.id, (r) => withVote(r, !review.viewerVoted, result.data)),
    }));
  };

  const openSpoiler = async (review: CommunityReview) => {
    const result = await fetchReview(anilistId, review.id);
    if (!result.ok) return fail(result);
    setSummary((cur) => ({ ...cur, reviews: updateItem(cur.reviews, review.id, (r) => withBody(r, result.data.body)) }));
  };

  const removeReview = async (review: CommunityReview) => {
    setBusyId(review.id);
    const result = await deleteReview(anilistId, review.id);
    setBusyId(null);
    if (!result.ok) return fail(result);
    applyWrite((cur) => ({
      ...cur,
      reviews: removeItem(cur.reviews, review.id),
      viewer: cur.viewer ? { ...cur.viewer, reviewId: null } : cur.viewer,
    }));
    notify("success", t("community.reviewDeleted"));
  };

  const moreReviews = async () => {
    setLoadingMore("reviews");
    const result = await fetchReviews(anilistId, summary.reviews.page + 1);
    setLoadingMore(null);
    if (!result.ok) return fail(result);
    setSummary((cur) => ({ ...cur, reviews: appendPage(cur.reviews, result.data) }));
  };

  // ── threads ──────────────────────────────────────────────────────────

  const submitThread = async (input: ThreadInput): Promise<boolean> => {
    setPosting(true);
    const result = await createThread(anilistId, input);
    setPosting(false);
    if (!result.ok) {
      fail(result);
      return false;
    }
    applyWrite((cur) => ({ ...cur, threads: prependItem(cur.threads, threadRowFrom(result.data)) }));
    setComposing(false);
    notify("success", t("community.threadPublished"));
    return true;
  };

  const moreThreads = async () => {
    setLoadingMore("threads");
    const result = await fetchThreads(anilistId, summary.threads.page + 1);
    setLoadingMore(null);
    if (!result.ok) return fail(result);
    setSummary((cur) => ({ ...cur, threads: appendPage(cur.threads, result.data) }));
  };

  // ── activity ─────────────────────────────────────────────────────────

  const toggleLike = async (item: CommunityActivity) => {
    setBusyId(item.id);
    const result = await setLike(anilistId, item.id, !item.viewerLiked);
    setBusyId(null);
    if (!result.ok) return fail(result);
    applyWrite((cur) => ({
      ...cur,
      activity: updateItem(cur.activity, item.id, (a) => withLike(a, !item.viewerLiked, result.data)),
    }));
  };

  const reply = async (item: CommunityActivity, body: string): Promise<boolean> => {
    setBusyId(item.id);
    const result = await createActivityReply(anilistId, item.id, { body });
    setBusyId(null);
    if (!result.ok) {
      fail(result);
      return false;
    }
    applyWrite((cur) => ({ ...cur, activity: updateItem(cur.activity, item.id, (a) => withReply(a, result.data)) }));
    return true;
  };

  const removeReply = async (item: CommunityActivity, target: CommunityReply) => {
    setBusyReplyId(target.id);
    const result = await deleteReply(anilistId, target.id);
    setBusyReplyId(null);
    if (!result.ok) return fail(result);
    applyWrite((cur) => ({ ...cur, activity: updateItem(cur.activity, item.id, (a) => withoutReply(a, target.id)) }));
  };

  const showAllReplies = async (item: CommunityActivity) => {
    const result = await fetchActivityEvent(anilistId, item.id);
    if (!result.ok) return fail(result);
    setSummary((cur) => ({ ...cur, activity: updateItem(cur.activity, item.id, () => result.data) }));
  };

  const moreActivity = async () => {
    setLoadingMore("activity");
    const result = await fetchActivity(anilistId, summary.activity.page + 1);
    setLoadingMore(null);
    if (!result.ok) return fail(result);
    setSummary((cur) => ({ ...cur, activity: appendPage(cur.activity, result.data) }));
  };

  // ── 谁在追 ──────────────────────────────────────────────────────────

  const follow = async () => {
    setFollowing(true);
    const result = await followAnime(anilistId);
    if (!result.ok) {
      setFollowing(false);
      return fail(result);
    }
    broadcastSubscription({ anilistId, sub: result.data });
    const watchers = await fetchWatchers(anilistId);
    setFollowing(false);
    applyWrite((cur) => ({
      ...cur,
      watchers: watchers.ok ? watchers.data : cur.watchers,
      viewer: { status: result.data.status, reviewId: cur.viewer?.reviewId ?? null },
    }));
  };

  const ownsReview = Boolean(summary.viewer?.reviewId) || summary.reviews.items.some((r) => r.isOwn);
  const showFollow = !viewer ? !probing : !summary.viewer?.status;

  if (status !== "ready") {
    return (
      <div className={s.root}>
        <div className={`container ${s.tab}`}>
          <div className={s.empty}>
            {status === "loading" ? (
              <div className={s.emptyTitle}>{t("community.loading")}</div>
            ) : (
              <>
                <div className={s.emptyTitle}>{t("community.loadFailed")}</div>
                <button type="button" className={`${s.btnSm} ${s.retry}`} onClick={() => void reload()}>
                  {t("community.retry")}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={s.root}>
      <div className={`container ${s.tab}`}>
        <div className={s.cols}>
          <div className={s.main}>
            <ReviewsSection
              page={summary.reviews}
              lang={lang}
              nowMs={nowMs}
              canAct={canAct}
              loginHref={loginHref}
              writeHref={writeHref}
              hasOwnReview={ownsReview}
              busyId={busyId}
              loadingMore={loadingMore === "reviews"}
              onLoadMore={() => void moreReviews()}
              onToggleHelpful={(r) => void toggleHelpful(r)}
              onOpenSpoiler={(r) => void openSpoiler(r)}
              onDelete={(r) => void removeReview(r)}
            />
            <ThreadsSection
              anilistId={anilistId}
              page={summary.threads}
              lang={lang}
              nowMs={nowMs}
              canAct={canAct}
              loginHref={loginHref}
              composing={composing}
              busy={posting}
              loadingMore={loadingMore === "threads"}
              onCompose={setComposing}
              onSubmit={submitThread}
              onLoadMore={() => void moreThreads()}
            />
            <ActivitySection
              page={summary.activity}
              animeTitle={animeTitle}
              coverUrl={coverUrl}
              lang={lang}
              nowMs={nowMs}
              canAct={canAct}
              me={me}
              loginHref={loginHref}
              highlightId={highlightId}
              busyId={busyId}
              busyReplyId={busyReplyId}
              loadingMore={loadingMore === "activity"}
              onLoadMore={() => void moreActivity()}
              onToggleLike={(item) => void toggleLike(item)}
              onReply={reply}
              onDeleteReply={(item, target) => void removeReply(item, target)}
              onShowAllReplies={(item) => void showAllReplies(item)}
            />
          </div>
          <aside className={s.aside}>
            <WatchersCard
              watchers={summary.watchers}
              lang={lang}
              nowMs={nowMs}
              showFollow={showFollow}
              canAct={canAct}
              loginHref={loginHref}
              following={following}
              onFollow={() => void follow()}
            />
          </aside>
        </div>
      </div>
    </div>
  );
}

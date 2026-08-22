"use client";

// The episode grid on /anime/[id] — and, since per-episode tracking landed,
// the control that writes the watched set rather than a read-only picture of
// it.
//
// What it used to be: a paint job over one number. The grid inferred `watched`
// from `currentEpisode` (see watchedEpisodeState.ts for the exact ladder), so a
// reader who had watched only episode 5 was shown green checkmarks on 1-4 as
// well — four specific claims about four specific episodes, none of which
// anyone had made. The set is stored now, every cell reads from it, and a click
// on a cell is what changes it. The ± stepper in SubscriptionButton, which was
// the only way to move that number, is gone.
//
// Why this stays a client component on a public detail page: the page is ISR +
// Cloudflare-edge-cached and its SERVER render must stay anonymous — one cached
// HTML for every visitor. So the whole watched-set lifecycle (read, paint,
// write) lives on the client behind the `auth_hint` cookie gate, exactly as the
// old read-only probe did. Nothing here may reach for cookies() or otherwise
// give the server a per-visitor answer. See the route note at the top of
// app/[lang]/anime/[id]/page.tsx.
//
// Auth shape follows lib/authChrome's invariant even though it does not import
// it (the answer here has three arms, not that module's three): while the probe
// is in flight we are "probing" and render a NEUTRAL, non-interactive cell —
// never a sign-in prompt. A logged-in visitor always carries auth_hint, so they
// never flash a "sign in" label over their own progress. Only once the probe
// resolves does a cell become either a real toggle or a sign-in prompt.
//
// Sub state sync: SubscriptionButton emits CustomEvents on the subscriptionBus
// after every successful mutation; we listen for status changes (completed) and
// removals, and we broadcast back after a toggle so the home/profile cards stop
// showing a progress number the detail page has already moved past.

import Link from "@/components/ui/LocaleLink";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import toast from "react-hot-toast";
import { authFetch } from "@/lib/authFetch";
import { hasAuthHint } from "@/lib/clientAuth";
import {
  broadcastSubscription,
  subscribeToBus,
  type SubscriptionDoc,
  type SubStatus,
} from "@/lib/subscriptionBus";
import type { DetailEpisodeTitle } from "@/lib/types";
import { pickEpisodeTitle } from "@/lib/formatters";
import { useLang } from "@/lib/lang-client";
import EpisodeComments from "@/components/anime/EpisodeComments";
import FallbackImg from "@/components/ui/FallbackImg";
import { DEFAULT_CARD_IMAGE } from "@/lib/cardDefaults";
import { authHrefWithFrom } from "@/components/auth/authFromLink";
import {
  localizeHref,
  useLocale,
  useLocaleRouter,
} from "@/components/ui/LocaleLink";
import {
  DISCUSSION_NAVIGATION_EVENT,
  applyDiscussionDelta,
  discussionHash,
  discussionTargetFromHref,
  parseDiscussionHash,
  parseEpisodeDiscussionSummary,
  type EpisodeDiscussionSummary,
} from "./episodeDiscussionState";
import { resolveEpisodeSkeleton } from "./episodeGridSkeleton";
import { classifyCreateStatus, docFromResponse } from "./subscriptionSetState";
import {
  EMPTY_WATCHED_TRACKER,
  autoStatusForSet,
  beginToggle,
  confirmToggle,
  episodeCellState,
  failWrite,
  isFurthestMarked,
  latestWatched,
  parseWatchedEpisodes,
  parseWatchedSnapshot,
  settleWrite,
  visibleWatched,
  watchedInGrid,
  type AutoStatus,
  type EpisodeCellState,
  type WatchedTracker,
} from "./watchedEpisodeState";

interface EpisodesGridProps {
  anilistId: number;
  episodes: number | null;
  /**
   * The inferred total (AnimeDetail.episodesBgm). Separate from `episodes` all
   * the way down for the reason spelled out in episodeGridSkeleton.ts: this
   * grid may draw from it, and schema.org may not, so nothing upstream is
   * allowed to hand these two down as one merged number.
   */
  episodesBgm: number | null;
  episodeTitles: DetailEpisodeTitle[];
}

/**
 * What we know about the visitor.
 *
 *   probing    the auth_hint-gated read has not answered. Cells are inert.
 *   anonymous  no session. Cells prompt to sign in instead of pretending.
 *   ready      signed in. `sub` says whether a subscription row exists yet.
 */
type Access = "probing" | "anonymous" | "ready";

/** Whether a subscription row exists to hang episode writes off. */
type EnsureResult = "ok" | "signedOut" | "failed";

const VALID_STATUSES: ReadonlyArray<SubStatus> = [
  "watching",
  "completed",
  "plan_to_watch",
  "dropped",
];

function parseSub(raw: unknown): SubscriptionDoc | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const data = (r.data ?? r) as Record<string, unknown> | null;
  if (!data || typeof data !== "object") return null;
  const status = typeof data.status === "string" ? data.status : "watching";
  if (!VALID_STATUSES.includes(status as SubStatus)) return null;
  return {
    status: status as SubStatus,
    currentEpisode:
      typeof data.currentEpisode === "number" ? data.currentEpisode : 0,
    score: typeof data.score === "number" ? data.score : null,
  };
}

/** `第 {{ep}} 集` / `Episode {{ep}}` style interpolation, as used repo-wide. */
function fill(template: string, values: Record<string, string | number>): string {
  let out = template;
  for (const [key, value] of Object.entries(values)) {
    out = out.split(`{{${key}}}`).join(String(value));
  }
  return out;
}

// Hover / focus lives in a stylesheet because neither can be expressed as an
// inline style, and these cells are now interactive: a keyboard user has to be
// able to SEE which cell they are on before they press it. Injected here rather
// than added to globals.css for the same reason SubscriptionButton injects its
// keyframe — globals.css is another surface's file.
const GRID_CSS = `
[data-episode-toggle]:not(:disabled):hover {
  background: rgba(255,255,255,0.07);
}
[data-episode-toggle]:focus-visible,
[data-episode-discussion]:focus-visible {
  outline: 2px solid #0a84ff;
  outline-offset: 2px;
}
[data-episode-discussion]:hover {
  background: rgba(10,132,255,0.28);
}
@media (prefers-reduced-motion: reduce) {
  [data-episode-toggle] { transition: none; }
}
`;

const headerRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  flexWrap: "wrap",
  gap: 10,
  marginBottom: 8,
};

const sectionLabelStyle: CSSProperties = {
  color: "#0a84ff",
  fontSize: 13,
  fontWeight: 600,
  letterSpacing: "2px",
  textTransform: "uppercase",
  margin: 0,
};

const progressStyle: CSSProperties = {
  fontSize: 12,
  color: "rgba(235,235,245,0.55)",
  fontVariantNumeric: "tabular-nums",
};

const hintStyle: CSSProperties = {
  margin: "0 0 14px",
  fontSize: 12,
  lineHeight: 1.5,
  color: "rgba(235,235,245,0.42)",
};

// The "we don't know the count yet" panel. Dashed rather than solid on
// purpose: it reads as a slot waiting to be filled, which is the whole claim
// being made, where the solid border used elsewhere in this section reads as
// finished content.
const pendingPanelStyle: CSSProperties = {
  border: "1px dashed #48484a",
  borderRadius: 12,
  padding: "18px 16px",
  background: "rgba(255,255,255,0.02)",
};

const pendingTitleStyle: CSSProperties = {
  margin: 0,
  color: "rgba(235,235,245,0.72)",
  fontSize: 14,
  fontWeight: 600,
};

const pendingHintStyle: CSSProperties = {
  margin: "6px 0 0",
  color: "rgba(235,235,245,0.42)",
  fontSize: 12,
  lineHeight: 1.5,
};

const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(88px, 1fr))",
  gap: 10,
};

/**
 * The cell's frame. Carries the whole visual state so the toggle inside can
 * stay a transparent, full-bleed hit area — a button nested inside a button is
 * invalid HTML, and the discussion chip has to be its own control.
 */
function shellStyle(
  state: EpisodeCellState,
  isOpen: boolean,
  isFurthest: boolean,
): CSSProperties {
  let background = "rgba(255,255,255,0.04)";
  let borderColor = "#38383a";
  if (state !== "unwatched") {
    background = "rgba(48,209,88,0.12)";
    // The furthest mark deepens the SAME green rather than introducing a
    // second colour. It is an annotation on a watched cell, and the old blue
    // box it replaces meant something else entirely — "current, not yet
    // watched" — so reinstating that treatment would re-import the meaning.
    borderColor = isFurthest ? "rgba(48,209,88,0.70)" : "rgba(48,209,88,0.30)";
  }
  // Open-panel highlight overrides the watched tint (legacy parity).
  if (isOpen) {
    background = "rgba(10,132,255,0.12)";
    borderColor = "rgba(10,132,255,0.55)";
  }
  return {
    position: "relative",
    background,
    border: `1px solid ${borderColor}`,
    borderRadius: 10,
    minWidth: 0,
    overflow: "hidden",
  };
}

/**
 * The anchor: a 2px rule along the bottom edge of the furthest marked cell.
 *
 * Deliberately quiet. A grid of two dozen cells with scattered marks gives a
 * reader nothing to orient by, and this is the one cell worth finding again —
 * but it must stay subordinate to the checkmark, because "watched" is the
 * claim and "furthest" is only a note about where the claims stop.
 */
const furthestBarStyle: CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  bottom: 0,
  height: 2,
  background: "#30d158",
  pointerEvents: "none",
};

const toggleStyle: CSSProperties = {
  display: "block",
  width: "100%",
  background: "transparent",
  border: 0,
  borderRadius: 10,
  padding: "10px 8px 8px",
  textAlign: "center",
  minWidth: 0,
  color: "inherit",
  fontFamily: "inherit",
  transition: "background 200ms",
};

function discussionStyle(isOpen: boolean, hasComments: boolean): CSSProperties {
  return {
    position: "absolute",
    top: 3,
    right: 3,
    zIndex: 1,
    minWidth: 24,
    height: 20,
    padding: "0 5px",
    borderRadius: 6,
    border: 0,
    background: isOpen ? "rgba(10,132,255,0.30)" : "rgba(120,120,128,0.18)",
    color: hasComments
      ? "rgba(235,235,245,0.80)"
      : "rgba(235,235,245,0.38)",
    fontSize: 9,
    fontWeight: 700,
    lineHeight: "20px",
    fontFamily: "inherit",
    cursor: "pointer",
    transition: "background 150ms",
  };
}

function numberStyle(state: EpisodeCellState, isOpen: boolean): CSSProperties {
  let color = "rgba(235,235,245,0.60)";
  if (state !== "unwatched") color = "#30d158";
  if (isOpen) color = "#0a84ff";
  return {
    fontSize: 20,
    fontWeight: 800,
    color,
    lineHeight: 1,
    marginBottom: 5,
    fontFamily: "'Sora', sans-serif",
  };
}

const kickerStyle: CSSProperties = {
  display: "block",
  fontSize: 10,
  color: "rgba(235,235,245,0.30)",
  marginBottom: 3,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.5px",
};

const checkStyle: CSSProperties = {
  display: "block",
  fontSize: 12,
  color: "#30d158",
  marginBottom: 2,
  minHeight: 14,
};

const cellTitleStyle: CSSProperties = {
  display: "block",
  fontSize: 9,
  color: "rgba(235,235,245,0.35)",
  marginTop: 2,
  lineHeight: 1.2,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

export default function EpisodesGrid({
  anilistId,
  episodes,
  episodesBgm,
  episodeTitles,
}: EpisodesGridProps) {
  const { lang, t } = useLang();
  const router = useLocaleRouter();
  const locale = useLocale();

  const [access, setAccess] = useState<Access>("probing");
  const [sub, setSub] = useState<SubscriptionDoc | null>(null);
  const [tracker, setTracker] = useState<WatchedTracker>(EMPTY_WATCHED_TRACKER);
  // Which episode's expand panel is open. null = all collapsed. Matches
  // legacy EpisodeList click-to-expand: click the discussion chip to open its
  // comment panel below, click again to collapse.
  const [openEp, setOpenEp] = useState<number | null>(null);
  const [highlightCommentId, setHighlightCommentId] = useState<string | null>(null);
  const [discussion, setDiscussion] = useState<EpisodeDiscussionSummary[]>([]);
  const panelRef = useRef<HTMLDivElement>(null);

  // Mirrors of the two pieces of state that async write handlers have to read
  // AFTER an await. Reading them off the render closure would hand a handler
  // whatever the values were when its click happened, which for overlapping
  // clicks is the wrong answer by construction. Written only through the
  // commit helpers below, and read only inside handlers — never during render.
  const trackerRef = useRef<WatchedTracker>(EMPTY_WATCHED_TRACKER);
  const subRef = useRef<SubscriptionDoc | null>(null);
  // Monotonic across this component's whole life. Every read and every write
  // takes one; it is the only thing that can tell settleWrite which of two
  // responses knows more. See settleWrite in watchedEpisodeState.ts.
  const tokenRef = useRef(0);
  const ensureRef = useRef<Promise<EnsureResult> | null>(null);

  const commitTracker = useCallback((next: WatchedTracker) => {
    trackerRef.current = next;
    setTracker(next);
  }, []);

  const commitSub = useCallback((next: SubscriptionDoc | null) => {
    subRef.current = next;
    setSub(next);
  }, []);

  // How many cells this grid is entitled to draw, and on whose authority.
  // See episodeGridSkeleton.ts — the short version is that a missing
  // catalogue count is not the same claim as "no episodes", and this section
  // used to make the second one by vanishing.
  const skeleton = useMemo(
    () => resolveEpisodeSkeleton(episodes, episodesBgm, episodeTitles),
    [episodes, episodesBgm, episodeTitles],
  );
  // Kept as a primitive so the effects below can depend on it without
  // re-running every time the parent hands down a fresh array.
  const total = skeleton.kind === "pending" ? 0 : skeleton.total;
  // The count auto-completion is allowed to act on, and ONLY the authoritative
  // one. An `inferred` total is a lower bound — a possibly-stale external count
  // or however many episode titles we hold — and this page already refuses to
  // print it as a total for that reason. Restating it as "you finished this",
  // in the reader's own subscription, is the same claim with consequences.
  // autoStatusForSet reads 0 as "no confirmed total"; see the asymmetry there.
  const confirmedTotal = skeleton.kind === "authoritative" ? skeleton.total : 0;

  // One public summary request makes discussion visible on every episode tile
  // without issuing N per-episode comment requests.
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`/api/comments/summary/${anilistId}?preview=2`, {
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        if (!res.ok) return;
        setDiscussion(parseEpisodeDiscussionSummary(await res.json()));
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setDiscussion([]);
        }
      }
    })();
    return () => controller.abort();
  }, [anilistId]);

  // Notification/feed links use a fragment so the ISR detail route never has
  // to read search params. Listen for same-page hash navigation as well as the
  // initial landing.
  useEffect(() => {
    // Bounded by the drawn grid rather than by the catalogue count: a deep
    // link has to land on a cell that exists, and once the grid can be sized
    // from episode titles alone those cells exist without a count. `total` is
    // 0 in the pending state, so nothing resolves — same as before.
    const applyTarget = (target: ReturnType<typeof parseDiscussionHash>) => {
      if (!target || target.episode > total) return;
      setOpenEp(target.episode);
      setHighlightCommentId(target.commentId);
    };
    const syncHash = () => applyTarget(parseDiscussionHash(window.location.hash));
    const syncNavigation = (event: Event) => {
      const href = (event as CustomEvent<{ href?: unknown }>).detail?.href;
      if (typeof href !== "string") return;
      applyTarget(discussionTargetFromHref(href, window.location.pathname));
    };
    syncHash();
    window.addEventListener("hashchange", syncHash);
    window.addEventListener(DISCUSSION_NAVIGATION_EVENT, syncNavigation);
    return () => {
      window.removeEventListener("hashchange", syncHash);
      window.removeEventListener(DISCUSSION_NAVIGATION_EVENT, syncNavigation);
    };
  }, [total]);

  useEffect(() => {
    if (openEp === null || highlightCommentId) return;
    panelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [openEp, highlightCommentId]);

  // Mount-time read — gated on the client `auth_hint` cookie so logged-out
  // visitors skip the fetch entirely and every cell settles to the sign-in
  // prompt without a request (ISSUE-001; the page is ISR/static and cannot
  // pass a server login signal). 401 is still handled below as a fallback for
  // a hint that outlived its session. Cancel on unmount in case the user
  // navigates fast.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!hasAuthHint()) {
        if (!cancelled) setAccess("anonymous");
        return;
      }
      const token = (tokenRef.current += 1);
      try {
        const res = await authFetch(`/api/subscriptions/${anilistId}`, {
          skipRedirectOnFailure: true,
        });
        if (cancelled) return;
        if (res.status === 401) {
          setAccess("anonymous");
          return;
        }
        // 404 = signed in with no subscription row yet: the cells are still
        // the reader's to click, and the first click creates the row.
        if (res.status === 404) {
          setAccess("ready");
          return;
        }
        if (!res.ok) {
          // 5xx / anything unexpected. Degrade to the sign-in prompt rather
          // than offer a toggle whose write we have no reason to trust.
          setAccess("anonymous");
          return;
        }
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        setAccess("ready");
        const parsed = parseSub(body);
        if (parsed) commitSub(parsed);
        commitTracker(
          settleWrite(trackerRef.current, token, null, parseWatchedEpisodes(body)),
        );
      } catch {
        if (!cancelled) setAccess("anonymous");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [anilistId, commitSub, commitTracker]);

  // Listen for SubscriptionButton mutations. We only care about events for
  // THIS anime; the bus is global. `completed` is the one status that changes
  // what a cell claims, and a removal takes the watched set with it.
  useEffect(() => {
    return subscribeToBus((detail) => {
      if (detail.anilistId !== anilistId) return;
      commitSub(detail.sub);
      if (detail.sub === null) {
        commitTracker(
          settleWrite(trackerRef.current, (tokenRef.current += 1), null, []),
        );
      }
    });
  }, [anilistId, commitSub, commitTracker]);

  const titleByEpisode = useMemo(() => {
    const m = new Map<number, DetailEpisodeTitle>();
    for (const row of episodeTitles) {
      if (typeof row.episode === "number") m.set(row.episode, row);
    }
    return m;
  }, [episodeTitles]);

  const discussionByEpisode = useMemo(
    () => new Map(discussion.map((row) => [row.episode, row])),
    [discussion],
  );

  const handleCommentDelta = useCallback((episode: number, delta: number) => {
    setDiscussion((before) => applyDiscussionDelta(before, episode, delta));
  }, []);

  const watched = useMemo(() => visibleWatched(tracker), [tracker]);
  const isCompleted = sub?.status === "completed";

  /**
   * Make sure a subscription row exists before the first episode write.
   *
   * The ± stepper used to do this implicitly — pressing + with no row POSTed
   * one — and dropping it would have made a signed-in reader's very first click
   * fail against a row that is not there. `ifAbsent` is the idempotent create
   * path, so a row that already exists (including a `dropped` or `completed`
   * one the reader set by hand) is left exactly as it was found.
   */
  const ensureSubscription = useCallback((): Promise<EnsureResult> => {
    if (subRef.current) return Promise.resolve<EnsureResult>("ok");
    // Two quick clicks on two cells would otherwise each POST a row and each
    // toast "added to your list" for one join.
    if (ensureRef.current) return ensureRef.current;
    const run = (async (): Promise<EnsureResult> => {
      try {
        const res = await authFetch("/api/subscriptions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ anilistId, status: "watching", ifAbsent: true }),
          skipRedirectOnFailure: true,
        });
        const verdict = classifyCreateStatus(res.status);
        if (verdict === "signedOut") return "signedOut";
        if (verdict !== "success") return "failed";
        const doc = docFromResponse(await res.json().catch(() => null));
        commitSub(doc);
        broadcastSubscription({ anilistId, sub: doc });
        // The one toast a cell click may earn: joining the list is a thing that
        // happened somewhere the reader cannot see. Per-episode checkmarks are
        // their own feedback and stay quiet.
        toast.success(t("sub.toastAdded"));
        return "ok";
      } finally {
        ensureRef.current = null;
      }
    })();
    ensureRef.current = run;
    return run;
  }, [anilistId, commitSub, t]);

  /**
   * Move the subscription's status because the watched set moved under it.
   *
   * Optimistic, and that matters twice over: the reader sees the whole grid
   * settle into (or out of) `completed` the instant they click, and a second
   * click landing while this PATCH is in flight reads the NEW status off
   * subRef, so autoStatusForSet answers null instead of firing the same
   * transition again.
   *
   * The episode write has already succeeded by the time this runs, so a failure
   * here must not read as "your episode was not recorded" — it says exactly
   * which half did not land.
   */
  const applyAutoStatus = useCallback(
    async (next: AutoStatus, episode: number) => {
      const previous = subRef.current;
      if (!previous || previous.status === next) return;
      const optimistic: SubscriptionDoc = { ...previous, status: next };
      commitSub(optimistic);
      broadcastSubscription({ anilistId, sub: optimistic });

      // Roll back the STATUS and nothing else. A toggle that landed while this
      // PATCH was in flight may have moved currentEpisode in the meantime, and
      // restoring the whole snapshot we captured before the call would take
      // that successful write down with the failed one.
      const revert = () => {
        const latest = subRef.current;
        const restored: SubscriptionDoc = latest
          ? { ...latest, status: previous.status }
          : previous;
        commitSub(restored);
        broadcastSubscription({ anilistId, sub: restored });
        toast.error(fill(t("detail.autoStatusFailed"), { ep: episode }));
      };

      try {
        const res = await authFetch(`/api/subscriptions/${anilistId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: next }),
          skipRedirectOnFailure: true,
        });
        if (res.status === 401) setAccess("anonymous");
        if (!res.ok) {
          revert();
          return;
        }
        // The status control lives in SubscriptionButton, far enough up the
        // page to be off screen when the click landed on episode 24. The select
        // repainting is not feedback the reader can see, so say it here.
        toast.success(
          next === "completed" ? t("detail.autoCompleted") : t("detail.autoResumed"),
        );
      } catch {
        revert();
      }
    },
    [anilistId, commitSub, t],
  );

  const toggleWatched = useCallback(
    async (episode: number) => {
      const token = (tokenRef.current += 1);
      const optimistic = beginToggle(
        trackerRef.current,
        episode,
        token,
        subRef.current?.status === "completed",
      );
      commitTracker(optimistic.tracker);

      // Roll back LOUDLY. A revert the reader does not notice is worse than the
      // inference bug this whole change removes: they would believe an episode
      // was recorded, find the checkmark gone later, and never have been told.
      // failWrite reports whether this write still owned the cell — a click the
      // reader has already reversed has nothing left to contradict.
      const rollBack = (message: string) => {
        const reverted = failWrite(trackerRef.current, token, episode);
        commitTracker(reverted.tracker);
        if (reverted.rolledBack) toast.error(message);
      };

      try {
        const ready = await ensureSubscription();
        if (ready === "signedOut") {
          setAccess("anonymous");
          rollBack(t("detail.watchedSignedOut"));
          return;
        }
        if (ready === "failed") {
          rollBack(fill(t("detail.watchedFailed"), { ep: episode }));
          return;
        }

        const res = await authFetch(
          `/api/subscriptions/${anilistId}/episodes/${episode}`,
          {
            method: optimistic.watched ? "PUT" : "DELETE",
            skipRedirectOnFailure: true,
          },
        );
        if (res.status === 401) {
          setAccess("anonymous");
          rollBack(t("detail.watchedSignedOut"));
          return;
        }
        if (!res.ok) {
          rollBack(fill(t("detail.watchedFailed"), { ep: episode }));
          return;
        }

        // Reconcile from the response rather than refetching: both writes
        // answer with the whole new set, and settleWrite refuses an answer that
        // a later write has already superseded. A success that states no set
        // (204, truncated body) may only promote this one cell — see
        // confirmToggle for what adopting its empty array would destroy.
        const snapshot = parseWatchedSnapshot(await res.json().catch(() => null));
        commitTracker(
          snapshot.stated
            ? settleWrite(trackerRef.current, token, episode, snapshot.watchedEpisodes)
            : confirmToggle(trackerRef.current, token, episode, optimistic.watched),
        );
        const current = subRef.current;
        if (current && current.currentEpisode !== snapshot.currentEpisode) {
          const next = { ...current, currentEpisode: snapshot.currentEpisode };
          commitSub(next);
          broadcastSubscription({ anilistId, sub: next });
        }

        // Only ever from here — a click. Nothing on the load path or the bus
        // reaches this, so opening a page can never rewrite a reader's status.
        const auto = autoStatusForSet(
          subRef.current?.status,
          visibleWatched(trackerRef.current),
          confirmedTotal,
        );
        if (auto) await applyAutoStatus(auto, episode);
      } catch {
        rollBack(fill(t("detail.watchedFailed"), { ep: episode }));
      }
    },
    [
      anilistId,
      applyAutoStatus,
      commitSub,
      commitTracker,
      confirmedTotal,
      ensureSubscription,
      t,
    ],
  );

  const goToLogin = useCallback(() => {
    // `from` names THIS anime rather than window.location, and the locale has
    // to be applied explicitly — same reasoning as SubscriptionButton's
    // anonymous branch, which this is deliberately consistent with.
    router.push(
      authHrefWithFrom("/login", localizeHref(`/anime/${anilistId}`, locale)),
    );
  }, [anilistId, locale, router]);

  // A plain function, not a useCallback: it reads `openEp` to decide whether
  // this click closes the panel, and the history rewrite that goes with that
  // decision is a side effect — putting either inside a setState updater would
  // make the updater impure and fire the rewrite twice under StrictMode.
  const openDiscussion = (episode: number) => {
    const closing = openEp === episode;
    setOpenEp(closing ? null : episode);
    setHighlightCommentId(null);
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}${
        closing ? "" : discussionHash(episode)
      }`,
    );
  };

  // Was `return null`, which deleted the whole section whenever the catalogue
  // had no episode count — and an absent section does not read as "unknown",
  // it reads as "none". Say what is actually true instead.
  if (skeleton.kind === "pending") {
    return (
      <section style={{ marginTop: 40, marginBottom: 60 }}>
        <h2 style={sectionLabelStyle}>{t("detail.episodes")}</h2>
        <div style={{ ...pendingPanelStyle, marginTop: 16 }}>
          <p style={pendingTitleStyle}>{t("detail.episodeCountPending")}</p>
          <p style={pendingHintStyle}>{t("detail.episodeCountPendingHint")}</p>
        </div>
      </section>
    );
  }

  // No `&& !isCompleted`. `completed` paints every cell watched, and a grid
  // that could not leave `completed` would be a grid whose toggles do nothing
  // on exactly the shows most likely to need a correction. Un-marking a cell
  // walks the status back to `watching` (autoStatusForSet), so the reader gets
  // out of `completed` from right here rather than hunting for the dropdown.
  const canToggle = access === "ready";
  const reading = latestWatched(watched, isCompleted, total);
  const previewEpisode = openEp ?? reading;
  const previewSummary = previewEpisode
    ? discussionByEpisode.get(previewEpisode)
    : undefined;

  const cells: { n: number; title: string }[] = [];
  for (let n = 1; n <= total; n += 1) {
    // Shared with the server-rendered grid in app/[lang]/anime/[id]/page.tsx —
    // the two used to hold byte-identical copies of this ladder.
    cells.push({ n, title: pickEpisodeTitle(titleByEpisode.get(n), lang) });
  }

  return (
    <section style={{ marginTop: 40, marginBottom: 60 }}>
      <style>{GRID_CSS}</style>
      <div style={headerRowStyle}>
        <h2 style={sectionLabelStyle}>{t("detail.episodes")}</h2>
        {access === "ready" && (
          <span style={progressStyle}>
            {fill(t("detail.watchedProgress"), {
              done: watchedInGrid(watched, isCompleted, total),
              total,
            })}
          </span>
        )}
      </div>
      {access === "ready" && (
        <p style={hintStyle}>
          {isCompleted
            ? t("detail.watchedCompletedHint")
            : t("detail.watchedHint")}
        </p>
      )}
      <div style={gridStyle}>
        {cells.map((cell) => {
          const state = episodeCellState(watched, isCompleted, cell.n);
          const isOpen = openEp === cell.n;
          const commentCount = discussionByEpisode.get(cell.n)?.count ?? 0;
          // An annotation ON a watched cell, not a state of its own — and read
          // off the SET, so a status-only `completed` (which marks nothing)
          // never gets one. Only shown once we know whose grid this is.
          const isFurthest =
            access === "ready" && isFurthestMarked(watched, total, cell.n);
          const action =
            access === "anonymous"
              ? fill(t("detail.watchedSignIn"), { ep: cell.n })
              : state === "unwatched"
                ? fill(t("detail.markWatched"), { ep: cell.n })
                : fill(t("detail.unmarkWatched"), { ep: cell.n });
          // Says what the annotation MEANS. "Furthest marked" is a fact about
          // the set; "in progress" or "up to here" would imply something about
          // the episodes around it, which is the reading this feature exists to
          // delete.
          const label = isFurthest
            ? `${action} · ${t("detail.furthestMarked")}`
            : action;

          // The cell body: identical markup inside the toggle and inside the
          // inert probing placeholder, so nothing shifts when the probe lands.
          const body = (
            <>
              <span style={kickerStyle}>{t("detail.ep")}</span>
              <span style={numberStyle(state, isOpen)}>{cell.n}</span>
              <span style={checkStyle} aria-hidden="true">
                {state === "unwatched" ? "" : "✓"}
              </span>
              {cell.title && (
                <span style={cellTitleStyle} title={cell.title}>
                  {cell.title}
                </span>
              )}
            </>
          );

          return (
            <div
              key={cell.n}
              style={shellStyle(state, isOpen, isFurthest)}
              data-furthest-marked={isFurthest ? "true" : undefined}
            >
              {isFurthest && <span style={furthestBarStyle} aria-hidden="true" />}
              {access === "probing" ? (
                // Neutral placeholder, never a sign-in prompt: a signed-in
                // reader must not see a "sign in" label flash over their own
                // progress while the probe is in flight (lib/authChrome).
                <div style={toggleStyle}>{body}</div>
              ) : (
                <button
                  type="button"
                  data-episode-toggle="true"
                  data-state={state}
                  aria-pressed={canToggle ? state !== "unwatched" : undefined}
                  aria-label={label}
                  title={label}
                  onClick={
                    access === "anonymous"
                      ? goToLogin
                      : () => void toggleWatched(cell.n)
                  }
                  style={{ ...toggleStyle, cursor: "pointer" }}
                >
                  {body}
                </button>
              )}
              <button
                type="button"
                data-episode-discussion="true"
                aria-expanded={isOpen}
                // Only while the panel exists: aria-controls pointing at an id
                // that is not in the document is a dangling reference.
                aria-controls={isOpen ? `episode-discussion-${cell.n}` : undefined}
                aria-label={fill(t("detail.episodeDiscussion"), { ep: cell.n })}
                onClick={() => openDiscussion(cell.n)}
                style={discussionStyle(isOpen, commentCount > 0)}
              >
                <span aria-hidden="true">
                  {commentCount > 0 ? `💬 ${commentCount}` : "💬"}
                </span>
              </button>
            </div>
          );
        })}
      </div>
      {previewEpisode && previewSummary?.latest.length ? (
        <div
          style={{
            marginTop: 14,
            padding: "12px 14px",
            borderRadius: 10,
            border: "1px solid rgba(84,84,88,0.55)",
            background: "rgba(255,255,255,0.025)",
          }}
        >
          <div style={{ fontSize: 11, color: "rgba(235,235,245,0.42)", marginBottom: 8 }}>
            {t("comment.previewTitle")} · {t("detail.ep")} {previewEpisode}
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            {previewSummary.latest.map((item) => (
              <div key={item.id} style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
                <Link
                  href={`/u/${encodeURIComponent(item.username)}`}
                  prefetch={false}
                  style={{ width: 24, height: 24, borderRadius: "50%", overflow: "hidden", flexShrink: 0 }}
                >
                  <FallbackImg
                    src={item.avatarUrl ?? item.backdropCoverUrl ?? DEFAULT_CARD_IMAGE}
                    fallback={DEFAULT_CARD_IMAGE}
                    alt={item.username}
                    style={{ width: "100%", height: "100%", objectFit: "cover" }}
                  />
                </Link>
                <button
                  type="button"
                  onClick={() => {
                    setOpenEp(previewEpisode);
                    setHighlightCommentId(item.id);
                    window.history.replaceState(
                      null,
                      "",
                      `${window.location.pathname}${window.location.search}${discussionHash(previewEpisode, item.id)}`,
                    );
                  }}
                  style={{ background: "none", border: 0, padding: 0, textAlign: "left", cursor: "pointer", minWidth: 0 }}
                >
                  <b style={{ display: "block", color: "#0a84ff", fontSize: 11, marginBottom: 2 }}>
                    {item.username}
                  </b>
                  <span style={{ color: "rgba(235,235,245,0.62)", fontSize: 12, lineHeight: 1.45 }}>
                    {item.isSpoiler ? t("comment.spoilerPreview") : item.content}
                  </span>
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {/* Legacy parity: click-to-expand panel under the grid, one episode
          at a time. (DanmakuSection — the legacy panel's live-danmaku half
          — is still deferred; it needs the ws-server socket hooks.) */}
      {openEp !== null && (
        <div
          id={`episode-discussion-${openEp}`}
          ref={panelRef}
          role="region"
          aria-label={`${t("comment.title")} · ${t("detail.ep")} ${openEp}`}
          style={{
            marginTop: 16,
            borderRadius: 12,
            overflow: "hidden",
            border: "1px solid #38383a",
            background: "rgba(255,255,255,0.02)",
          }}
        >
          <EpisodeComments
            key={openEp}
            anilistId={anilistId}
            episode={openEp}
            highlightCommentId={highlightCommentId}
            onCommentDelta={handleCommentDelta}
          />
        </div>
      )}
    </section>
  );
}

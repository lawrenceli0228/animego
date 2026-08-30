"use client";

// LABELS NEEDED (DetailActions.tsx must pass all of these on `labels`):
//   - login          : "登录后追番"          (sub.loginToWatch)
//   - loginAria      : aria-label for login button
//   - add            : "+ 添加到列表"        (sub.addToList) — placeholder option in <select>
//   - remove         : "移除"                (sub.remove)
//   - rate           : "评分"                (sub.rate) — shown on score button when no score set
//   - watching       : "在看"                (sub.watching)
//   - completed      : "看完"                (sub.completed)
//   - planToWatch    : "想看"                (sub.planToWatch)
//   - dropped        : "放弃"                (sub.dropped)
//
// Port of legacy client/src/components/subscription/SubscriptionButton.jsx.
//
// Auth model: parent page is a public RSC, so we probe
//   GET /api/subscriptions/:anilistId
// on mount via authFetch({skipRedirectOnFailure:true}). Three outcomes:
//   - 200 → user logged in with sub doc          → render 4-control panel
//   - 404 → user logged in but no sub yet        → render "+ 追番" outline button
//   - 401 → anonymous                            → render "登录后追番" link
//
// Panel shown when state='subscribed':
//   [status <select>]  [★ score]  [移除]
//
// The `− N + / total 集` stepper used to sit between the select and the score.
// It was the only way to move `currentEpisode`, and `currentEpisode` was the
// only thing the episode grid had to colour cells from — which is why the grid
// had to GUESS which episodes those were. Episodes are tracked per episode now
// and the grid writes them directly (EpisodesGrid.tsx); `currentEpisode` is
// derived server-side from the set, so a second control that sets it by hand
// would be a second, disagreeing source of truth for the same fact.
//
// State writes go through authFetch directly (no TanStack Query). On
// any 5xx/network failure we revert the optimistic local state and toast
// the failure; on 200 we toast what actually happened. The Toaster lives
// in next-app/src/app/layout.tsx, above every route.
//
// Toast copy used to be one glyph — '✓' for every success, '!' for every
// failure — which told the user nothing about which of the four writes
// landed and, worse, never mentioned that the thing they just subscribed
// to is collected somewhere. Subscribing morphs this button in place and
// nothing else on the page moves, so without the copy the action reads as
// a toggle rather than as adding to a list, and 234 of 255 subscribers
// never added a second show. The first subscribe on a device therefore
// carries a link to /profile (see takeListHint).
//
// Why useLang() here when every other string arrives on `labels`: toast
// copy is transient client-side feedback, and widening `labels` for it
// would mean editing DetailActions + page.tsx to thread four more strings
// through two components that never render them. The *-spa dictionaries
// back t(), and src/locales/spaDictCoverage.test.ts holds the keys.
//
// Why no react-query: parent (DetailActions / page.tsx) doesn't wrap
// us in a QueryClientProvider, and adding one just for this surface
// would balloon scope. Plain local state + authFetch covers the
// optimistic-update pattern the legacy hooks gave us.

import { useEffect, useRef, useState, type CSSProperties } from "react";
import Link from "@/components/ui/LocaleLink";
import { useLocaleRouter } from "@/components/ui/LocaleLink";
import toast from "react-hot-toast";
import { authFetch } from "@/lib/authFetch";
import { hasAuthHint } from "@/lib/clientAuth";
import {
  peekWatchedProgress,
  subscribeWatchedProgress,
} from "@/lib/watchedProgress";
import { useLang } from "@/lib/lang-client";
import { broadcastSubscription, subscribeToBus } from "@/lib/subscriptionBus";
import { hintStore, takeListHint, LIST_HINT_TOAST_MS } from "./subscriptionToast";
import { authHrefWithFrom } from "@/components/auth/authFromLink";
import { localizeHref, useLocale } from "@/components/ui/LocaleLink";

interface Labels {
  login: string;
  loginAria: string;
  add: string;
  remove: string;
  rate: string;
  watching: string;
  completed: string;
  planToWatch: string;
  dropped: string;
}

interface SubscriptionButtonProps {
  anilistId: number;
  /** Total episodes, for the "watched N / total" readout. Null when unknown. */
  episodes: number | null;
  labels: Labels;
}

type SubStatus = "watching" | "completed" | "plan_to_watch" | "dropped";

interface SubscriptionDoc {
  status: SubStatus;
  currentEpisode: number;
  score: number | null;
}

type LoadState = "loading" | "anonymous" | "available" | "subscribed";

const STATUS_VALUES: readonly SubStatus[] = [
  "watching",
  "completed",
  "plan_to_watch",
  "dropped",
] as const;

// LIST_HINT_TOAST_MS is imported from ./subscriptionToast, not re-declared:
// the detail page and the card grid draw the same one-shot hint from the same
// store, so a value that drifts between them would show the same user two
// different windows for the same message and no test would catch it.

const toastBodyStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "baseline",
  flexWrap: "wrap",
  gap: 10,
};

const toastLinkStyle: CSSProperties = {
  color: "#0a84ff",
  fontWeight: 600,
  textDecoration: "none",
  whiteSpace: "nowrap",
};

const wrapStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 12,
  // DetailActions owns the outer spacing (rowStyle marginTop:16); we
  // intentionally clear the legacy 24px vertical padding here.
  padding: 0,
};

// Every control in this row is 44px tall.
//
// They were 32, 36, 40 and 44 depending on which object built them, because
// each was written next to the thing it styles rather than against the row
// it lands in — and the row also contains three <Button>s from components/ui,
// whose base is 44. A row of controls at four different heights reads as
// broken before it reads as anything else.
//
// 44 rather than the smallest of them: it is the touch-target floor in
// DESIGN.md, and this row is the primary action strip on the page.
const CONTROL_HEIGHT = 44;

// The chevron, drawn rather than left to the platform.
//
// A <select> renders the OS widget by default — a beveled arrow on macOS, a
// different one on Windows, a full-width native picker on Android — so this
// was the one control in the row that looked like it came from somewhere
// else. `appearance: none` removes it and this draws the replacement.
//
// A background-image and not a pseudo-element: a <select> cannot host ::after
// (it has no accessible box to render into), and the alternative — wrapping
// it in a span that draws the arrow — needs a stylesheet this component does
// not have, since every style here is an inline object.
//
// Stroke colour is baked in because a data URI cannot read currentColor.
const CHEVRON = encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="6" viewBox="0 0 10 6">' +
    '<path d="M1 1l4 4 4-4" fill="none" stroke="rgba(235,235,245,0.55)" ' +
    'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
);

/* The status select and the progress readout share one frame.
 *
 * The border, radius and fill live on this wrapper rather than on the
 * <select>, so the two read as one control the way the design draws them —
 * status on the left, a hairline, then how far you are. The select keeps its
 * own hit area and all of its native behaviour; it just stops painting a box
 * of its own. */
const statusGroupStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: CONTROL_HEIGHT,
  borderRadius: 8,
  background: "#2c2c2e",
  border: "1px solid #38383a",
  overflow: "hidden",
};

const selectStyle: CSSProperties = {
  alignSelf: "stretch",
  // Right padding clears the chevron; without it a long status label runs
  // underneath it.
  padding: "0 30px 0 16px",
  background: `transparent url("data:image/svg+xml,${CHEVRON}") no-repeat right 12px center`,
  border: 0,
  color: "#ffffff",
  fontSize: 14,
  fontFamily: "inherit",
  cursor: "pointer",
  outline: "none",
  appearance: "none",
  WebkitAppearance: "none",
  MozAppearance: "none",
};

/* 1px tall-ish rule between the two halves. Inset vertically so it reads as
 * a divider inside the control rather than as the control being two. */
const statusSepStyle: CSSProperties = {
  width: 1,
  height: 16,
  flexShrink: 0,
  background: "rgba(235,235,245,0.16)",
};

const progressStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "0 14px 0 12px",
  fontSize: 13,
  color: "rgba(235,235,245,0.60)",
  whiteSpace: "nowrap",
};

/* The count itself, brighter and tabular so the control does not resize by a
 * pixel as it ticks 9 → 10. */
const progressCountStyle: CSSProperties = {
  color: "#ffffff",
  fontWeight: 600,
  fontVariantNumeric: "tabular-nums",
};

const progressDenomStyle: CSSProperties = {
  color: "rgba(235,235,245,0.38)",
  fontVariantNumeric: "tabular-nums",
};

const progressBarStyle: CSSProperties = {
  position: "relative",
  width: 44,
  height: 3,
  marginLeft: 2,
  borderRadius: 99,
  background: "rgba(235,235,245,0.14)",
  overflow: "hidden",
};

const removeBtnStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: CONTROL_HEIGHT,
  padding: "0 16px",
  borderRadius: 8,
  border: "1px solid rgba(255,69,58,0.4)",
  color: "#ff453a",
  fontSize: 13,
  cursor: "pointer",
  background: "rgba(255,69,58,0.08)",
  transition: "all 0.2s",
};

const loginBtnStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "0 18px",
  borderRadius: 8,
  background: "#0a84ff",
  color: "#fff",
  fontWeight: 600,
  fontSize: 13,
  textDecoration: "none",
  minHeight: CONTROL_HEIGHT,
  lineHeight: "20px",
  border: "none",
  cursor: "pointer",
  outline: "none",
};

const addBtnStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "0 18px",
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  minHeight: CONTROL_HEIGHT,
  outline: "none",
  border: "1px solid rgba(84,84,88,0.65)",
  background: "transparent",
  color: "rgba(235,235,245,0.60)",
  transition:
    "background 150ms, border-color 150ms, color 150ms, transform 120ms",
};

const placeholderStyle: CSSProperties = {
  padding: "0 18px",
  borderRadius: 8,
  border: "1px solid rgba(84,84,88,0.30)",
  background: "transparent",
  color: "transparent",
  pointerEvents: "none",
  minWidth: 110,
  minHeight: CONTROL_HEIGHT,
};

const scoreBtnBase: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: CONTROL_HEIGHT,
  padding: "0 14px",
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  fontVariantNumeric: "tabular-nums",
  outline: "none",
};

const scorePopupStyle: CSSProperties = {
  position: "absolute",
  top: "calc(100% + 6px)",
  left: 0,
  zIndex: 100,
  background: "#2c2c2e",
  border: "1px solid #38383a",
  borderRadius: 10,
  padding: "8px",
  display: "flex",
  gap: 4,
  boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
};

function scoreNumBtnStyle(
  n: number,
  current: number | null,
): CSSProperties {
  const isActive = n === current;
  const isBelow = n <= (current ?? 0);
  return {
    width: 30,
    height: 30,
    borderRadius: 6,
    border: "none",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 700,
    fontVariantNumeric: "tabular-nums",
    // The anime's colour, matching the rated pill this popup sets. It was
    // iOS Blue, which made the picker the one surface in the hero still
    // painted in the site's operation colour while everything it touches had
    // moved to the show's.
    background: isActive
      ? "var(--poster-tone, #0a84ff)"
      : isBelow
        ? "var(--poster-tone-low, rgba(120,120,128,0.20))"
        : "rgba(120,120,128,0.12)",
    // Dark-on-tone for the selected number, same pairing as the primary CTA:
    // white on --poster-tone is under the contrast floor at most hues.
    color: isActive
      ? "oklch(15% 0.03 var(--poster-hue))"
      : isBelow
        ? "var(--poster-tone, rgba(235,235,245,0.85))"
        : "rgba(235,235,245,0.55)",
    // Named properties, not `all`. DESIGN.md rules `transition: all` out, and
    // here it would also animate the width/height/border-radius on every
    // re-render of a ten-button row.
    transition: "background 150ms var(--ease-out-expo), color 150ms var(--ease-out-expo)",
  };
}

export default function SubscriptionButton({
  anilistId,
  episodes,
  labels,
}: SubscriptionButtonProps) {
  const router = useLocaleRouter();
  const { t } = useLang();
  const locale = useLocale();
  // Page is statically prerendered / ISR (no server cookie read), so the
  // initial render can't know login state — start in "loading" (a neutral
  // placeholder that matches the SSR HTML, no hydration mismatch). The
  // mount effect reads the non-httpOnly `auth_hint` cookie on the client to
  // decide: logged-out → "anonymous" (no probe), logged-in → fire the probe.
  const [state, setState] = useState<LoadState>("loading");
  const [sub, setSub] = useState<SubscriptionDoc | null>(null);
  const [busy, setBusy] = useState(false);
  const [scoreOpen, setScoreOpen] = useState(false);
  const scoreRef = useRef<HTMLDivElement | null>(null);

  // The watched count, owned by EpisodesGrid and mirrored here.
  //
  // Seeded from `sub.currentEpisode` (which the server derives from the same
  // set) and then kept live by the grid's notifications, so ticking an
  // episode updates both readouts at once instead of leaving this one on the
  // value it fetched at mount.
  // Seeded lazily rather than in the effect. A setState called synchronously
  // in an effect body renders twice and trips react-hooks/set-state-in-effect;
  // an initialiser runs once, before the first paint, with the same result.
  const [watchedCount, setWatchedCount] = useState<number | null>(
    () => peekWatchedProgress(anilistId)?.watched ?? null,
  );
  useEffect(
    () =>
      subscribeWatchedProgress((p) => {
        // Guard the id: this component survives a client-side navigation
        // between two anime, and the grid for the previous one can still be
        // unmounting when the next one mounts.
        if (p.anilistId === anilistId) setWatchedCount(p.watched);
      }),
    [anilistId],
  );

  const statusLabels: Record<SubStatus, string> = {
    watching: labels.watching,
    completed: labels.completed,
    plan_to_watch: labels.planToWatch,
    dropped: labels.dropped,
  };

  // Mount probe — mirrors legacy useSubscription({enabled:!!user}).
  // Gate on the client `auth_hint` cookie: when absent the visitor is
  // logged out, so we settle straight to "anonymous" and fire NO request.
  // Without this gate every anonymous detail-page view fires
  // GET /api/subscriptions/:id → 401 → refresh → 401 (ISSUE-001). The
  // httpOnly session cookie is unreadable on the client, but the
  // non-httpOnly `auth_hint` (set by go-api on login) is the readable proxy.
  useEffect(() => {
    if (!hasAuthHint()) {
      setState("anonymous");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch(`/api/subscriptions/${anilistId}`, {
          skipRedirectOnFailure: true,
        });
        if (cancelled) return;
        if (res.status === 401) {
          setState("anonymous");
          return;
        }
        if (res.status === 404) {
          setState("available");
          return;
        }
        if (res.ok) {
          const body = (await res.json().catch(() => null)) as
            | { data?: Partial<SubscriptionDoc> | null }
            | null;
          // 200 + data:null = not subscribed (the endpoint returns this
          // instead of 404 so the probe doesn't spam the console).
          if (body?.data == null) {
            setState("available");
            return;
          }
          const data = body.data;
          const parsed: SubscriptionDoc = {
            status: (data.status as SubStatus) ?? "watching",
            currentEpisode:
              typeof data.currentEpisode === "number"
                ? data.currentEpisode
                : 0,
            score:
              typeof data.score === "number" ? data.score : null,
          };
          setSub(parsed);
          setState("subscribed");
          broadcastSubscription({ anilistId, sub: parsed });
          return;
        }
        // Unknown → degrade gracefully to anonymous so the user at
        // least sees a working CTA instead of a busted panel.
        setState("anonymous");
      } catch {
        if (!cancelled) setState("anonymous");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [anilistId]);

  // Listen as well as broadcast. This panel used to be the only thing on the
  // page that WROTE a subscription, so a one-way bus was enough. The episode
  // grid writes now — marking the last episode moves the status to `completed`
  // and un-marking one walks it back — and without this the select would go on
  // reading `在看` under a subscription the server had already completed. The
  // stalest control on the page would be the one that owns the field.
  //
  // No echo loop: our own broadcasts hand back the identical object we just
  // stored, and setState bails on Object.is.
  useEffect(() => {
    return subscribeToBus((detail) => {
      if (detail.anilistId !== anilistId) return;
      setSub(detail.sub);
      setState((current) =>
        current === "anonymous"
          ? current
          : detail.sub
            ? "subscribed"
            : "available",
      );
    });
  }, [anilistId]);

  // Outside-click close for score popup (matches legacy mousedown
  // listener pattern).
  useEffect(() => {
    if (!scoreOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        scoreRef.current &&
        e.target instanceof Node &&
        !scoreRef.current.contains(e.target)
      ) {
        setScoreOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [scoreOpen]);

  // ------------------------------------------------------------------
  // Toasts — one per outcome, so the writes stop looking identical.
  // ------------------------------------------------------------------

  const toastFailed = () => toast.error(t("sub.toastFailed"));

  /** A brand-new subscription row was created (not a status/ep edit). */
  const toastAdded = () => {
    if (!takeListHint(hintStore())) {
      toast.success(t("sub.toastAdded"));
      return;
    }
    // First one on this device: say where it went. Dismiss on click so the
    // toast doesn't outlive the navigation it just triggered.
    toast.success(
      (instance) => (
        <span style={toastBodyStyle}>
          {t("sub.toastAdded")}
          <Link
            href="/profile"
            style={toastLinkStyle}
            onClick={() => toast.dismiss(instance.id)}
          >
            {t("sub.toastViewList")}
          </Link>
        </span>
      ),
      { duration: LIST_HINT_TOAST_MS },
    );
  };

  // ------------------------------------------------------------------
  // Mutations — each one writes optimistically, reverts on failure.
  // ------------------------------------------------------------------

  const createSub = async (
    payload: Partial<SubscriptionDoc> & { status: SubStatus },
  ): Promise<SubscriptionDoc | null> => {
    const res = await authFetch("/api/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ anilistId, ...payload }),
      skipRedirectOnFailure: true,
    });
    if (res.status === 401) {
      setState("anonymous");
      return null;
    }
    if (!res.ok && res.status !== 201) return null;
    const body = (await res.json().catch(() => null)) as
      | { data?: Partial<SubscriptionDoc> }
      | null;
    const data = body?.data ?? {};
    return {
      status: (data.status as SubStatus) ?? payload.status,
      currentEpisode:
        typeof data.currentEpisode === "number"
          ? data.currentEpisode
          : payload.currentEpisode ?? 0,
      score:
        typeof data.score === "number"
          ? data.score
          : payload.score ?? null,
    };
  };

  const patchSub = async (
    updates: Partial<SubscriptionDoc>,
  ): Promise<SubscriptionDoc | null> => {
    const res = await authFetch(`/api/subscriptions/${anilistId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
      skipRedirectOnFailure: true,
    });
    if (res.status === 401) {
      setState("anonymous");
      return null;
    }
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as
      | { data?: Partial<SubscriptionDoc> }
      | null;
    const data = body?.data ?? {};
    return {
      status: (data.status as SubStatus) ?? sub?.status ?? "watching",
      currentEpisode:
        typeof data.currentEpisode === "number"
          ? data.currentEpisode
          : sub?.currentEpisode ?? 0,
      score:
        typeof data.score === "number"
          ? data.score
          : data.score === null
            ? null
            : sub?.score ?? null,
    };
  };

  const handleStatus = async (next: string) => {
    if (busy) return;
    if (!STATUS_VALUES.includes(next as SubStatus)) return;
    const nextStatus = next as SubStatus;
    const prev = sub;
    const isCreate = !sub;
    setBusy(true);
    try {
      let updated: SubscriptionDoc | null;
      if (!sub) {
        updated = await createSub({ status: nextStatus });
      } else {
        // Optimistic update.
        setSub({ ...sub, status: nextStatus });
        updated = await patchSub({ status: nextStatus });
      }
      if (updated) {
        setSub(updated);
        setState("subscribed");
        broadcastSubscription({ anilistId, sub: updated });
        // Moving between buckets is not the same event as joining the list:
        // echo the bucket the show landed in (the <select> already reads that
        // way, but the toast is what confirms the write reached the server).
        if (isCreate) toastAdded();
        else toast.success(statusLabels[updated.status]);
      } else {
        // Revert.
        setSub(prev);
        toastFailed();
      }
    } finally {
      setBusy(false);
    }
  };

  const handleScore = async (n: number) => {
    if (busy || !sub) return;
    const newScore = n === sub.score ? null : n;
    const prev = sub;
    setBusy(true);
    try {
      setSub({ ...sub, score: newScore });
      // Server clamps to 1..10 or null. We send raw value; null toggles off.
      const updated = await patchSub({ score: newScore });
      if (updated) {
        setSub(updated);
        setScoreOpen(false);
        broadcastSubscription({ anilistId, sub: updated });
        // No success toast: the score button repaints with the new number
        // right where the click landed, so a toast would only cover it.
      } else {
        setSub(prev);
        toastFailed();
      }
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async () => {
    if (busy) return;
    const prev = sub;
    setBusy(true);
    try {
      const res = await authFetch(`/api/subscriptions/${anilistId}`, {
        method: "DELETE",
        skipRedirectOnFailure: true,
      });
      if (res.status === 401) {
        setState("anonymous");
        return;
      }
      if (res.ok || res.status === 204) {
        setSub(null);
        setState("available");
        broadcastSubscription({ anilistId, sub: null });
        toast.success(t("sub.toastRemoved"));
      } else {
        setSub(prev);
        toastFailed();
      }
    } finally {
      setBusy(false);
    }
  };

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  if (state === "loading") {
    return <button type="button" style={placeholderStyle} aria-hidden />;
  }

  if (state === "anonymous") {
    // `from` names THIS anime rather than the current page — the button
    // also renders on card grids, and after signing in the reader should
    // land on the show they tried to subscribe to. That is why it is built
    // by hand instead of from usePathname, and why it needs the locale
    // applied explicitly: nothing else in the chain can see it.
    const target = authHrefWithFrom("/login", localizeHref(`/anime/${anilistId}`, locale));
    return (
      <button
        type="button"
        aria-label={labels.loginAria}
        onClick={() => router.push(target)}
        style={loginBtnStyle}
      >
        {labels.login}
      </button>
    );
  }

  if (state === "available") {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={() => handleStatus("watching")}
        style={addBtnStyle}
      >
        {labels.add}
      </button>
    );
  }

  // state === "subscribed"
  const currentStatus = sub?.status ?? "watching";
  // The grid's live count when we have it, otherwise the value the server
  // derived from the same set at fetch time. Both describe one fact; the
  // first is just fresher.
  const shownWatched = watchedCount ?? sub?.currentEpisode ?? null;
  const currentScore = sub?.score ?? null;

  return (
    <div style={wrapStyle}>
      {/* No `disabled={busy}` on the select — a write elsewhere in this panel
          flips busy briefly, which would re-paint the browser-default disabled
          styling and make the dropdown flicker. handleStatus has its own
          `if (busy) return` to drop conflicting status writes mid-mutation. */}
      <div style={statusGroupStyle}>
        <select
          style={selectStyle}
          value={currentStatus}
          onChange={(e) => handleStatus(e.target.value)}
          aria-label={labels.watching}
        >
          <option value="" disabled>
            {labels.add}
          </option>
          {STATUS_VALUES.map((v) => (
            <option key={v} value={v}>
              {statusLabels[v]}
            </option>
          ))}
        </select>

        {/* Read-only. The count comes from EpisodesGrid, which owns the
            watched set; there is no control here to change it, which is the
            distinction that matters — see this file's header on why the old
            stepper was removed. Hidden when the total is unknown, because
            "7 / ?" says less than the episode list already does. */}
        {shownWatched !== null && episodes && episodes > 0 ? (
          <>
            <span style={statusSepStyle} aria-hidden="true" />
            <span style={progressStyle}>
              {t("detail.watchedShort")}
              <span style={progressCountStyle}>{shownWatched}</span>
              <span style={progressDenomStyle}>/{episodes}</span>
              {/* aria-hidden: the two numbers beside it already say this, and
                  an unlabelled bar is noise in a screen reader. */}
              <span style={progressBarStyle} aria-hidden="true">
                <span
                  style={{
                    display: "block",
                    height: "100%",
                    width: `${Math.min(100, (shownWatched / episodes) * 100)}%`,
                    borderRadius: 99,
                    background: "var(--success)",
                  }}
                />
              </span>
            </span>
          </>
        ) : null}
      </div>

      <div ref={scoreRef} style={{ position: "relative" }}>
        <button
          type="button"
          disabled={busy}
          onClick={() => setScoreOpen((open) => !open)}
          style={{
            ...scoreBtnBase,
            // Rated: the anime's colour, matching the AniList figure in the
            // facts line above it. It was iOS Blue, which made the one
            // control showing YOUR opinion of the show the only thing on the
            // hero not tinted by the show.
            //
            // Unrated stays neutral. The tint means "you have scored this";
            // painting the empty state too would spend the signal on the
            // state that has nothing to say.
            //
            // tone-on-tone-low is the same pairing as the format badge, and
            // lib/oklch.test.ts proves it clears 4.5:1 at every hue.
            background: currentScore
              ? "var(--poster-tone-low, rgba(10,132,255,0.12))"
              : "#2c2c2e",
            border: currentScore
              ? "1px solid var(--poster-tone-mid, rgba(10,132,255,0.4))"
              : "1px solid #38383a",
            color: currentScore
              ? "var(--poster-tone, #0a84ff)"
              : "rgba(235,235,245,0.60)",
          }}
        >
          {`★ ${currentScore ? `${currentScore}/10` : labels.rate}`}
        </button>
        {scoreOpen && (
          <div style={scorePopupStyle}>
            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
              <button
                key={n}
                type="button"
                disabled={busy}
                onClick={() => handleScore(n)}
                style={scoreNumBtnStyle(n, currentScore)}
              >
                {n}
              </button>
            ))}
          </div>
        )}
      </div>

      <button
        type="button"
        style={removeBtnStyle}
        disabled={busy}
        onClick={handleRemove}
      >
        {labels.remove}
      </button>
    </div>
  );
}

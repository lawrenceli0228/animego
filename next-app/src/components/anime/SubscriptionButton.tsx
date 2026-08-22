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

const selectStyle: CSSProperties = {
  padding: "10px 16px",
  borderRadius: 8,
  background: "#2c2c2e",
  border: "1px solid #38383a",
  color: "#ffffff",
  fontSize: 14,
  cursor: "pointer",
  outline: "none",
  minWidth: 150,
};

const removeBtnStyle: CSSProperties = {
  padding: "10px 16px",
  borderRadius: 8,
  border: "1px solid rgba(255,69,58,0.4)",
  color: "#ff453a",
  fontSize: 13,
  cursor: "pointer",
  background: "rgba(255,69,58,0.08)",
  transition: "all 0.2s",
};

const loginBtnStyle: CSSProperties = {
  display: "inline-block",
  padding: "10px 18px",
  borderRadius: 8,
  background: "#0a84ff",
  color: "#fff",
  fontWeight: 600,
  fontSize: 13,
  textDecoration: "none",
  minHeight: 40,
  lineHeight: "20px",
  border: "none",
  cursor: "pointer",
  outline: "none",
};

const addBtnStyle: CSSProperties = {
  padding: "10px 18px",
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  minHeight: 40,
  outline: "none",
  border: "1px solid rgba(84,84,88,0.65)",
  background: "transparent",
  color: "rgba(235,235,245,0.60)",
  transition:
    "background 150ms, border-color 150ms, color 150ms, transform 120ms",
};

const placeholderStyle: CSSProperties = {
  padding: "10px 18px",
  borderRadius: 8,
  border: "1px solid rgba(84,84,88,0.30)",
  background: "transparent",
  color: "transparent",
  pointerEvents: "none",
  minWidth: 110,
  minHeight: 40,
};

const scoreBtnBase: CSSProperties = {
  padding: "8px 14px",
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
    background: isActive ? "#0a84ff" : "rgba(120,120,128,0.12)",
    color: isActive
      ? "#fff"
      : isBelow
        ? "#0a84ff"
        : "rgba(235,235,245,0.60)",
    transition: "all 0.15s",
  };
}

export default function SubscriptionButton({
  anilistId,
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
  const currentScore = sub?.score ?? null;

  return (
    <div style={wrapStyle}>
      {/* No `disabled={busy}` on the select — a write elsewhere in this panel
          flips busy briefly, which would re-paint the browser-default disabled
          styling and make the dropdown flicker. handleStatus has its own
          `if (busy) return` to drop conflicting status writes mid-mutation. */}
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

      <div ref={scoreRef} style={{ position: "relative" }}>
        <button
          type="button"
          disabled={busy}
          onClick={() => setScoreOpen((open) => !open)}
          style={{
            ...scoreBtnBase,
            background: currentScore
              ? "rgba(10,132,255,0.12)"
              : "#2c2c2e",
            border: currentScore
              ? "1px solid rgba(10,132,255,0.4)"
              : "1px solid #38383a",
            color: currentScore
              ? "#0a84ff"
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

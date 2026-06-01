"use client";

// LABELS NEEDED (DetailActions.tsx must pass all of these on `labels`):
//   - login          : "登录后追番"          (sub.loginToWatch)
//   - loginAria      : aria-label for login button
//   - add            : "+ 添加到列表"        (sub.addToList) — placeholder option in <select>
//   - remove         : "移除"                (sub.remove)
//   - rate           : "评分"                (sub.rate) — shown on score button when no score set
//   - epUnit         : "集"                  (sub.epUnit) — suffix after "/ N"
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
// v2 panel (legacy parity) shows when state='subscribed':
//   [status <select>]  [− N + / total 集]  [★ score]  [移除]
//
// State writes go through authFetch directly (no TanStack Query). On
// any 5xx/network failure we revert the optimistic local state and
// toast.error('!'); on 200 we toast.success('✓'). Toaster is not yet
// mounted in next-app/src/app/layout.tsx (P6 follow-up) but several
// existing components already call `toast.*` — landing the toaster
// will retro-light all of them at once.
//
// Why no react-query: parent (DetailActions / page.tsx) doesn't wrap
// us in a QueryClientProvider, and adding one just for this surface
// would balloon scope. Plain local state + authFetch covers the
// optimistic-update pattern the legacy hooks gave us.

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import { authFetch } from "@/lib/authFetch";
import { hasAuthHint } from "@/lib/clientAuth";
import { broadcastSubscription } from "@/lib/subscriptionBus";

interface Labels {
  login: string;
  loginAria: string;
  add: string;
  remove: string;
  rate: string;
  epUnit: string;
  watching: string;
  completed: string;
  planToWatch: string;
  dropped: string;
}

interface SubscriptionButtonProps {
  anilistId: number;
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

// fadeUp keyframe (matches legacy client/src/index.css). We inject
// inline because globals.css is owned by another surface and adding
// a one-off keyframe there for this component is overreach.
const FADE_UP_CSS =
  "@keyframes subBtnFadeUp{from{opacity:0;transform:translate(-50%,4px)}to{opacity:1;transform:translate(-50%,0)}}";

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

const epWrapStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  background: "#2c2c2e",
  border: "1px solid #38383a",
  borderRadius: 8,
  padding: "4px 8px",
};

const epBtnStyle: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 6,
  background: "rgba(10,132,255,0.12)",
  color: "#0a84ff",
  fontSize: 16,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  border: "none",
  transition: "background 0.2s",
};

const epNumStyle: CSSProperties = {
  minWidth: 32,
  textAlign: "center",
  fontSize: 14,
  fontWeight: 600,
  color: "#ffffff",
  fontVariantNumeric: "tabular-nums",
};

const epUnitStyle: CSSProperties = {
  fontSize: 12,
  color: "rgba(235,235,245,0.30)",
  marginLeft: 4,
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

function statusHintStyle(kind: SubStatus): CSSProperties {
  const isCompleted = kind === "completed";
  return {
    position: "absolute",
    bottom: "calc(100% + 6px)",
    left: "50%",
    transform: "translateX(-50%)",
    background: isCompleted
      ? "rgba(48,209,88,0.15)"
      : "rgba(10,132,255,0.15)",
    border: `1px solid ${
      isCompleted ? "rgba(48,209,88,0.4)" : "rgba(10,132,255,0.4)"
    }`,
    borderRadius: 8,
    padding: "4px 12px",
    whiteSpace: "nowrap",
    fontSize: 12,
    fontWeight: 600,
    color: isCompleted ? "#30d158" : "#0a84ff",
    animation: "subBtnFadeUp 0.3s ease both",
    pointerEvents: "none",
  };
}

export default function SubscriptionButton({
  anilistId,
  episodes,
  labels,
}: SubscriptionButtonProps) {
  const router = useRouter();
  // Page is statically prerendered / ISR (no server cookie read), so the
  // initial render can't know login state — start in "loading" (a neutral
  // placeholder that matches the SSR HTML, no hydration mismatch). The
  // mount effect reads the non-httpOnly `auth_hint` cookie on the client to
  // decide: logged-out → "anonymous" (no probe), logged-in → fire the probe.
  const [state, setState] = useState<LoadState>("loading");
  const [sub, setSub] = useState<SubscriptionDoc | null>(null);
  const [busy, setBusy] = useState(false);
  const [scoreOpen, setScoreOpen] = useState(false);
  const [statusHint, setStatusHint] = useState<SubStatus | null>(null);
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
            | { data?: Partial<SubscriptionDoc> }
            | null;
          const data = body?.data ?? {};
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

  const showStatusHint = (kind: SubStatus) => {
    setStatusHint(kind);
    window.setTimeout(() => setStatusHint(null), 2500);
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
        toast.success("✓");
      } else {
        // Revert.
        setSub(prev);
        toast.error("!");
      }
    } finally {
      setBusy(false);
    }
  };

  const handleEp = async (rawEp: number) => {
    if (busy) return;
    const maxEp = episodes && episodes > 0 ? episodes : 9999;
    const val = Math.max(0, Math.min(rawEp, maxEp));
    const currentStatus = sub?.status;
    const autoComplete = !!episodes && episodes > 0 && val >= episodes;
    const autoResume =
      !!episodes &&
      episodes > 0 &&
      val < episodes &&
      currentStatus === "completed";
    const newStatus: SubStatus | undefined = autoComplete
      ? "completed"
      : autoResume
        ? "watching"
        : undefined;

    const prev = sub;
    setBusy(true);
    try {
      // Optimistic.
      const optimistic: SubscriptionDoc = sub
        ? {
            ...sub,
            currentEpisode: val,
            status: newStatus ?? sub.status,
          }
        : {
            status: newStatus ?? "watching",
            currentEpisode: val,
            score: null,
          };
      setSub(optimistic);

      const updated = sub
        ? await patchSub({
            currentEpisode: val,
            ...(newStatus ? { status: newStatus } : {}),
          })
        : await createSub({
            status: newStatus ?? "watching",
            currentEpisode: val,
          });

      if (updated) {
        setSub(updated);
        setState("subscribed");
        broadcastSubscription({ anilistId, sub: updated });
        if (autoComplete) showStatusHint("completed");
      } else {
        setSub(prev);
        toast.error("!");
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
      } else {
        setSub(prev);
        toast.error("!");
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
        toast.success("✓");
      } else {
        setSub(prev);
        toast.error("!");
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
    const target = `/login?from=${encodeURIComponent(`/anime/${anilistId}`)}`;
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
  const currentEp = sub?.currentEpisode ?? 0;
  const currentStatus = sub?.status ?? "watching";
  const currentScore = sub?.score ?? null;
  const epMax = episodes && episodes > 0 ? episodes : null;

  return (
    <div style={wrapStyle}>
      <style>{FADE_UP_CSS}</style>

      {/* No `disabled={busy}` on the select — every +/− click flips
          busy briefly, which would re-paint the browser-default disabled
          styling and make the dropdown flicker on every counter click.
          handleStatus has its own `if (busy) return` to drop conflicting
          status writes mid-mutation. */}
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

      <div style={{ position: "relative" }}>
        {statusHint && (
          <div style={statusHintStyle(statusHint)}>
            {statusLabels[statusHint]} ✓
          </div>
        )}
        <div style={epWrapStyle}>
          <button
            type="button"
            style={epBtnStyle}
            disabled={busy}
            onClick={() => handleEp(currentEp - 1)}
            aria-label="-1"
          >
            −
          </button>
          <span style={epNumStyle}>{currentEp}</span>
          <button
            type="button"
            style={epBtnStyle}
            disabled={busy}
            onClick={() => handleEp(currentEp + 1)}
            aria-label="+1"
          >
            +
          </button>
          <span style={epUnitStyle}>
            {epMax ? `/ ${epMax} ${labels.epUnit}` : labels.epUnit}
          </span>
        </div>
      </div>

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

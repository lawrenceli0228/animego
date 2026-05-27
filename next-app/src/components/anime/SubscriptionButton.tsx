"use client";

// Client port of legacy SubscriptionButton.jsx.
//
// Auth model: the parent page is a public RSC, so we can't trust an
// isLoggedIn prop. Instead we probe `/api/subscriptions/:anilistId`
// on mount via authFetch with skipRedirectOnFailure=true. The probe
// distinguishes three states:
//   - 200 → user is logged in AND has a subscription doc; render the
//           "Watching" pill + remove button.
//   - 404 → user is logged in but has no subscription for this anime;
//           render the "+ 追番" outline button.
//   - 401 → user is anonymous; render the "登录后追番" link, click
//           navigates to /login?from=/anime/:id.
//
// v1 keeps the surface minimal — no episode +/- counter, no score
// picker, no status dropdown. Those are valuable but the legacy panel
// is 180 lines of UI and would dwarf the row. Subscribe / unsubscribe
// covers the day-1 "为什么旧版有的功能新版没有" gap. v2.1 follow-up
// can layer the episode counter back on top once we agree on the spot
// for it (the legacy version put it inline next to the dropdown; on
// the new layout that pushes the share / torrents / play buttons off
// the visible row).

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { authFetch } from "@/lib/authFetch";

interface Labels {
  login: string;
  add: string;
  watching: string;
  remove: string;
  loginAria: string;
}

interface SubscriptionButtonProps {
  anilistId: number;
  labels: Labels;
}

type LoadState = "loading" | "anonymous" | "subscribed" | "available";

const baseButtonStyle = {
  padding: "10px 18px",
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  minHeight: 40,
  outline: "none",
  border: "none",
  transition:
    "background 150ms, border-color 150ms, color 150ms, transform 120ms, box-shadow 150ms",
} as const;

const outlineStyle = (hover: boolean, focus: boolean) => ({
  ...baseButtonStyle,
  border: `1px solid ${hover ? "rgba(120,120,128,0.9)" : "rgba(84,84,88,0.65)"}`,
  background: hover ? "rgba(120,120,128,0.12)" : "transparent",
  color: hover ? "rgba(255,255,255,0.92)" : "rgba(235,235,245,0.60)",
  transform: hover ? "translateY(-1px)" : "none",
  boxShadow: focus ? "0 0 0 3px rgba(120,120,128,0.28)" : "none",
});

const subscribedStyle = (hover: boolean, focus: boolean) => ({
  ...baseButtonStyle,
  background: hover ? "rgba(48,209,88,0.18)" : "rgba(48,209,88,0.12)",
  border: "1px solid rgba(48,209,88,0.45)",
  color: "#30d158",
  transform: hover ? "translateY(-1px)" : "none",
  boxShadow: focus ? "0 0 0 3px rgba(48,209,88,0.28)" : "none",
});

const loginLinkStyle = {
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
} as const;

const placeholderStyle = {
  ...baseButtonStyle,
  background: "transparent",
  border: "1px solid rgba(84,84,88,0.30)",
  color: "transparent",
  pointerEvents: "none" as const,
  minWidth: 110,
};

export default function SubscriptionButton({
  anilistId,
  labels,
}: SubscriptionButtonProps) {
  const router = useRouter();
  const [state, setState] = useState<LoadState>("loading");
  const [busy, setBusy] = useState(false);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch(`/api/subscriptions/${anilistId}`, {
          skipRedirectOnFailure: true,
        });
        if (cancelled) return;
        if (res.status === 401) {
          setState("anonymous");
        } else if (res.status === 404) {
          setState("available");
        } else if (res.ok) {
          setState("subscribed");
        } else {
          // Unknown error — fall back to "anonymous" so the worst case
          // is a visible login CTA rather than a broken UI.
          setState("anonymous");
        }
      } catch {
        if (!cancelled) setState("anonymous");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [anilistId]);

  const subscribe = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await authFetch("/api/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ anilistId, status: "watching" }),
        skipRedirectOnFailure: true,
      });
      if (res.status === 401) {
        setState("anonymous");
        return;
      }
      if (res.ok || res.status === 201) {
        setState("subscribed");
      }
    } finally {
      setBusy(false);
    }
  };

  const unsubscribe = async () => {
    if (busy) return;
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
        setState("available");
      }
    } finally {
      setBusy(false);
    }
  };

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
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        style={{
          ...loginLinkStyle,
          background: hover ? "#3395ff" : "#0a84ff",
          boxShadow: focus
            ? "0 0 0 3px rgba(10,132,255,0.45)"
            : hover
              ? "0 2px 8px rgba(10,132,255,0.35)"
              : "none",
        }}
      >
        {labels.login}
      </button>
    );
  }

  if (state === "subscribed") {
    return (
      <button
        type="button"
        onClick={unsubscribe}
        disabled={busy}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        style={subscribedStyle(hover, focus)}
        aria-label={labels.remove}
        title={labels.remove}
      >
        {hover ? labels.remove : labels.watching}
      </button>
    );
  }

  // available
  return (
    <button
      type="button"
      onClick={subscribe}
      disabled={busy}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      style={outlineStyle(hover, focus)}
    >
      {labels.add}
    </button>
  );
}

"use client";

// Share the detail page URL. Uses the Web Share API when available
// (mobile + Safari on macOS), falls back to clipboard + a temporary
// inline confirmation pill. We deliberately avoid a toast dep —
// alert() is too disruptive and there's no global toast wired yet.

import { useState } from "react";

interface ShareButtonProps {
  anilistId: number;
  shareTitle: string;
  labels: {
    share: string;
    copied: string;
    copyFailed: string;
  };
}

const baseStyle = {
  padding: "10px 18px",
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  minHeight: 40,
  outline: "none",
  transition:
    "background 150ms, border-color 150ms, color 150ms, transform 120ms, box-shadow 150ms",
} as const;

const idleStyle = (hover: boolean, focus: boolean) => ({
  ...baseStyle,
  border: `1px solid ${hover ? "rgba(120,120,128,0.9)" : "rgba(84,84,88,0.65)"}`,
  background: hover ? "rgba(120,120,128,0.12)" : "transparent",
  color: hover ? "rgba(255,255,255,0.92)" : "rgba(235,235,245,0.60)",
  transform: hover ? "translateY(-1px)" : "none",
  boxShadow: focus ? "0 0 0 3px rgba(120,120,128,0.28)" : "none",
});

const confirmStyle = {
  ...baseStyle,
  border: "1px solid rgba(48,209,88,0.45)",
  background: "rgba(48,209,88,0.12)",
  color: "#30d158",
  cursor: "default" as const,
};

export default function ShareButton({
  anilistId,
  shareTitle,
  labels,
}: ShareButtonProps) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [feedback, setFeedback] = useState<"copied" | "failed" | null>(null);

  const handleClick = async () => {
    const url =
      typeof window !== "undefined"
        ? `${window.location.origin}/anime/${anilistId}`
        : `/anime/${anilistId}`;
    const titleFull = `${shareTitle} — AnimeGoClub`;

    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({ title: titleFull, url });
        return;
      } catch {
        // User cancelled or browser denied — fall through to clipboard.
      }
    }

    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(url);
        setFeedback("copied");
      } else {
        setFeedback("failed");
      }
    } catch {
      setFeedback("failed");
    }
    window.setTimeout(() => setFeedback(null), 2200);
  };

  if (feedback) {
    return (
      <button type="button" disabled style={confirmStyle} aria-live="polite">
        {feedback === "copied" ? `✓ ${labels.copied}` : labels.copyFailed}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      style={idleStyle(hover, focus)}
    >
      {labels.share}
    </button>
  );
}

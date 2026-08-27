"use client";

// Share the detail page URL. Uses the Web Share API when available
// (mobile + Safari on macOS), falls back to clipboard + a temporary
// inline confirmation pill. We deliberately avoid a toast dep —
// alert() is too disruptive and there's no global toast wired yet.

import { useState } from "react";
import Button from "@/components/ui/Button";

interface ShareButtonProps {
  anilistId: number;
  shareTitle: string;
  labels: {
    share: string;
    copied: string;
    copyFailed: string;
  };
}

// The style objects that were here — base, idle(hover, focus) and confirm —
// are the `outline` and `confirm` variants of components/ui/Button. They were
// duplicated character for character in MagnetButton, and the hover/focus
// halves were two useState hooks re-rendering this component on every mouse
// enter to do what a CSS pseudo-class does for free.

export default function ShareButton({
  anilistId,
  shareTitle,
  labels,
}: ShareButtonProps) {
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
      <Button variant="confirm" disabled aria-live="polite">
        {feedback === "copied" ? `✓ ${labels.copied}` : labels.copyFailed}
      </Button>
    );
  }

  return (
    <Button variant="outline" onClick={handleClick}>
      {labels.share}
    </Button>
  );
}

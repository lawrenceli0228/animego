"use client";

// Open the danmaku player in a new tab. The /player route is gated
// by proxy.ts — anonymous viewers land on /login first, which is the
// right behaviour (player needs auth for local file access + library).
//
// The legacy SPA opened `/player` with no params and let the
// DropZone handle the rest. We preserve that surface; threading an
// anilistId here would mean teaching the player drop flow to seed
// from a series ID, which is out of scope for v1.

import { useState } from "react";

interface PlayButtonProps {
  ariaLabel: string;
  children: string;
}

const baseStyle = {
  padding: "10px 18px",
  borderRadius: 8,
  border: "none",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  minHeight: 40,
  color: "#fff",
  outline: "none",
  transition: "background 150ms, transform 120ms, box-shadow 150ms",
} as const;

export default function PlayButton({ ariaLabel, children }: PlayButtonProps) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);

  const handleClick = () => {
    if (typeof window === "undefined") return;
    window.open("/player", "_blank", "noopener,noreferrer");
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      aria-label={ariaLabel}
      style={{
        ...baseStyle,
        background: hover ? "#3395ff" : "#0a84ff",
        transform: hover ? "translateY(-1px)" : "none",
        boxShadow: focus
          ? "0 0 0 3px rgba(10,132,255,0.45)"
          : hover
            ? "0 2px 8px rgba(10,132,255,0.35)"
            : "none",
      }}
    >
      {children}
    </button>
  );
}

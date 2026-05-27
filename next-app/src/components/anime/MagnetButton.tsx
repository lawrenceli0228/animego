"use client";

// Outline button that opens the TorrentModal. Pulled out of
// DetailActions so the modal trigger has its own hover state without
// re-rendering the rest of the row.

import { useState } from "react";

interface MagnetButtonProps {
  onOpen: () => void;
  label: string;
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

export default function MagnetButton({ onOpen, label }: MagnetButtonProps) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);

  return (
    <button
      type="button"
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      style={{
        ...baseStyle,
        border: `1px solid ${hover ? "rgba(120,120,128,0.9)" : "rgba(84,84,88,0.65)"}`,
        background: hover ? "rgba(120,120,128,0.12)" : "transparent",
        color: hover ? "rgba(255,255,255,0.92)" : "rgba(235,235,245,0.60)",
        transform: hover ? "translateY(-1px)" : "none",
        boxShadow: focus ? "0 0 0 3px rgba(120,120,128,0.28)" : "none",
      }}
    >
      {label}
    </button>
  );
}

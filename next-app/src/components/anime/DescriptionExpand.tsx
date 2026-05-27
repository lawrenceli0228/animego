"use client";

import { useState } from "react";
import type { CSSProperties } from "react";

// Tiny client component for the legacy "展开更多 / 收起" UX on the
// anime detail Hero description. Pure presentation — receives the
// already-stripped + already-truncated text plus the full text and a
// pre-computed "needs toggle" flag (callers compute these server-side
// so SEO crawlers see the full text without JS). When the user clicks
// 展开更多, swaps to the full text. The button visibility is driven by
// `needsToggle`, not by comparing strings at runtime.

const textStyle: CSSProperties = {
  color: "rgba(235,235,245,0.60)",
  fontSize: 14,
  lineHeight: 1.8,
  margin: 0,
  whiteSpace: "pre-wrap",
};

const buttonStyle: CSSProperties = {
  color: "#0a84ff",
  fontSize: 13,
  fontWeight: 600,
  marginTop: 8,
  cursor: "pointer",
  background: "none",
  border: "none",
  padding: 0,
};

interface DescriptionExpandProps {
  truncated: string;
  full: string;
  needsToggle: boolean;
  expandLabel: string;
  collapseLabel: string;
}

export default function DescriptionExpand({
  truncated,
  full,
  needsToggle,
  expandLabel,
  collapseLabel,
}: DescriptionExpandProps) {
  const [expanded, setExpanded] = useState(false);
  // Whitespace inside the source description is collapsed during
  // stripHtml so a single string + whiteSpace:pre-wrap matches the
  // legacy "single paragraph that wraps" look without the visible
  // blank-line gaps that <br><br> produces.
  return (
    <div>
      <p style={textStyle}>{expanded ? full : truncated}</p>
      {needsToggle ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={buttonStyle}
          aria-expanded={expanded}
        >
          {expanded ? collapseLabel : expandLabel}
        </button>
      ) : null}
    </div>
  );
}

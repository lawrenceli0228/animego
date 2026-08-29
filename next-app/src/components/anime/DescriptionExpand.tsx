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
};

const buttonStyle: CSSProperties = {
  // The derived tone, not the raw sample. `--poster-accent` is the colour
  // taken straight off the cover and nothing bounds its contrast: measured
  // across real accents it runs 3.58:1 to 8.84:1 against black, so on some
  // anime this control was legible and on others it was not. `--poster-tone`
  // is the same hue re-derived at a fixed lightness — see globals.css.
  color: "var(--poster-tone, #0a84ff)",
  fontSize: 13,
  fontWeight: 600,
  marginTop: 8,
  cursor: "pointer",
  background: "none",
  border: "none",
  padding: 0,
};

// Attribution sits a full step below the body copy in the hierarchy: it is
// a credit, not content. Underlined because colour alone would not read as
// a link at this weight.
const sourceStyle: CSSProperties = {
  color: "rgba(235,235,245,0.35)",
  fontSize: 12,
  lineHeight: 1.6,
  margin: "10px 0 0",
};

const sourceLinkStyle: CSSProperties = {
  color: "inherit",
  textDecoration: "underline",
  textUnderlineOffset: 2,
};

interface DescriptionExpandProps {
  truncated: string;
  full: string;
  needsToggle: boolean;
  expandLabel: string;
  collapseLabel: string;
  /**
   * Marks the rendered text as transcribed from a third party, excluding it
   * from search snippets. We republish Bangumi's community-written synopsis
   * verbatim; letting it compete for the snippet on our URL would put
   * someone else's paragraph under our result. `data-nosnippet` scopes the
   * exclusion to this block — the rest of the page still snippets normally.
   *
   * Off by default, so the AniList description keeps behaving exactly as it
   * always has.
   */
  nosnippet?: boolean;
  /**
   * Credit line text, e.g. "简介来自 Bangumi". Drives the credit on its own:
   * the attribution must not depend on a second field, because the reason we
   * print it (the text is someone else's) is exactly the reason `nosnippet`
   * is set. Tying the two to different conditions is how a page ends up
   * republishing a third party's paragraph with no credit at all.
   */
  sourceLabel?: string;
  /**
   * Where the credit points, e.g. https://bgm.tv/subject/123. Optional: with
   * no href the credit still renders, just as plain text. A missing subject
   * id is a reason to drop the link, never a reason to drop the attribution.
   */
  sourceHref?: string;
}

export default function DescriptionExpand({
  truncated,
  full,
  needsToggle,
  expandLabel,
  collapseLabel,
  nosnippet = false,
  sourceLabel,
  sourceHref,
}: DescriptionExpandProps) {
  const [expanded, setExpanded] = useState(false);
  // Spread rather than `data-nosnippet={cond ? "" : undefined}` so the
  // attribute is absent — not empty — from the markup when off, keeping the
  // AniList-description output byte-identical to the pre-channel render.
  const snippetAttr = nosnippet ? { "data-nosnippet": "" } : {};
  return (
    <div {...snippetAttr}>
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
      {sourceLabel ? (
        <p style={sourceStyle}>
          {sourceHref ? (
            <a
              href={sourceHref}
              target="_blank"
              rel="noopener noreferrer"
              style={sourceLinkStyle}
            >
              {sourceLabel}
            </a>
          ) : (
            sourceLabel
          )}
        </p>
      ) : null}
    </div>
  );
}

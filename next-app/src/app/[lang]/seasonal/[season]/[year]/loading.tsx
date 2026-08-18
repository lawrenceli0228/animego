// Streaming fallback for the seasonal grid RSC tree. Shown while page.tsx
// awaits getDict() + the Go API's /seasonal endpoint on cold cache.
//
// Visual rhythm matches the rendered page IN ORDER so the swap doesn't
// jump: heading bar → SeasonNav row → SeasonalFilterChips pill cloud
// (~28 chips: 18 genres + 6 formats + 3 statuses + sort) → card grid at
// the same 3/4 aspect-ratio + minmax(180px) the real AnimeCard grid uses.
// Pure CSS animation — no motion lib — this file must never slow paint.

import type { CSSProperties } from "react";
import { estimateChipWidth } from "@/lib/chipWidth";
import {
  FILTER_GENRES,
  formatLabel,
  genreLabel,
  statusLabel,
} from "@/lib/contentLabels";

const PLACEHOLDER_CARDS = 18;

// Chip widths are derived from the labels SeasonalFilterChips actually paints
// rather than hardcoded, so the pill cloud wraps on the same line count as the
// real row. They were transcribed from the English names until the chips were
// localised; the Chinese genre row is ~33% narrower, enough to reserve one
// wrapped line the real content does not use and jump the grid on swap.
// The two rows use different pill geometry, so they are measured separately:
// genre chips are 10px padding + 1px border, format/status chips 14px + none.
const SKELETON_FORMATS = ["TV", "TV_SHORT", "MOVIE", "SPECIAL", "OVA", "ONA"];
const SKELETON_STATUSES = ["RELEASING", "FINISHED", "NOT_YET_RELEASED"];

const GENRE_CHIP_WIDTHS = FILTER_GENRES.map((g) =>
  estimateChipWidth(genreLabel(g, "zh")),
);
const FILTER_CHIP_WIDTHS = [
  ...SKELETON_FORMATS.map((f) =>
    estimateChipWidth(formatLabel(f, "zh"), { paddingX: 14, border: 0 }),
  ),
  ...SKELETON_STATUSES.map((s) =>
    estimateChipWidth(statusLabel(s, "zh"), { paddingX: 14, border: 0 }),
  ),
];

const containerStyle: CSSProperties = {
  paddingTop: 40,
  paddingBottom: 40,
};

const chapterBarStyle: CSSProperties = {
  position: "absolute",
  left: 28,
  top: 44,
  width: 3,
  height: 52,
  background: "oklch(62% 0.19 260)",
  borderRadius: 2,
  boxShadow: "0 0 24px oklch(62% 0.19 260 / 0.55)",
  opacity: 0.7,
};

const headerWrapStyle: CSSProperties = {
  position: "relative",
  paddingLeft: 32,
  marginBottom: 24,
};

const skeletonBoxStyle = (w: number | string, h: number): CSSProperties => ({
  background:
    "linear-gradient(90deg, rgba(60,60,66,0.30) 0%, rgba(84,84,88,0.40) 50%, rgba(60,60,66,0.30) 100%)",
  backgroundSize: "200% 100%",
  animation: "seasonalPulse 1.6s ease-in-out infinite",
  borderRadius: 8,
  width: typeof w === "number" ? `${w}px` : w,
  height: h,
  flexShrink: 0,
});

const headingPlaceholderStyle: CSSProperties = {
  ...skeletonBoxStyle("min(420px, 50vw)", 38),
  marginBottom: 18,
};

const navRowStyle: CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "center",
  flexWrap: "wrap",
  marginBottom: 18,
};

// Mirrors SeasonalFilterChips: rows of pills that wrap. Two visual rows —
// genres, then formats+statuses+sort — separated by a little gap.
const chipCloudStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const chipRowStyle: CSSProperties = {
  display: "flex",
  gap: 6,
  flexWrap: "wrap",
  alignItems: "center",
};

const cardStyle: CSSProperties = {
  ...skeletonBoxStyle("100%", 0),
  aspectRatio: "3 / 4",
  borderRadius: 12,
};

export default function SeasonalLoading() {
  return (
    <main
      aria-busy="true"
      aria-live="polite"
      className="container"
      style={containerStyle}
    >
      <style>{`
        @keyframes seasonalPulse {
          0%, 100% { background-position: 0% 50%; }
          50%      { background-position: 100% 50%; }
        }
        @media (prefers-reduced-motion: reduce) {
          [data-seasonal-pulse] { animation: none !important; opacity: 0.35; }
        }
      `}</style>

      <div style={headerWrapStyle}>
        <span style={chapterBarStyle} aria-hidden />
        <div data-seasonal-pulse style={headingPlaceholderStyle} />

        {/* SeasonNav: prev / season label / next */}
        <div style={navRowStyle}>
          <div data-seasonal-pulse style={skeletonBoxStyle(80, 32)} />
          <div data-seasonal-pulse style={skeletonBoxStyle(160, 32)} />
          <div data-seasonal-pulse style={skeletonBoxStyle(80, 32)} />
        </div>

        {/* SeasonalFilterChips: genre row + format/status/sort row + count */}
        <div style={chipCloudStyle}>
          <div style={chipRowStyle} aria-hidden>
            {GENRE_CHIP_WIDTHS.map((w, i) => (
              <div key={`g${i}`} data-seasonal-pulse style={skeletonBoxStyle(w, 30)} />
            ))}
          </div>
          <div style={chipRowStyle} aria-hidden>
            {FILTER_CHIP_WIDTHS.map((w, i) => (
              <div key={`f${i}`} data-seasonal-pulse style={skeletonBoxStyle(w, 30)} />
            ))}
            <div data-seasonal-pulse style={{ ...skeletonBoxStyle(120, 30), marginLeft: "auto" }} />
          </div>
          <div data-seasonal-pulse style={skeletonBoxStyle(96, 16)} />
        </div>
      </div>

      <div className="anime-grid-5col" style={{ marginTop: 24 }}>
        {Array.from({ length: PLACEHOLDER_CARDS }, (_, i) => (
          <div key={i} data-seasonal-pulse style={cardStyle} aria-hidden />
        ))}
      </div>
    </main>
  );
}

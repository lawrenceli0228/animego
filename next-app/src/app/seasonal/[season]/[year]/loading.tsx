// Streaming fallback for the seasonal grid RSC tree. Shown while page.tsx
// awaits getDict() + the Go API's /seasonal endpoint on cold cache.
//
// Visual rhythm matches the rendered page IN ORDER so the swap doesn't
// jump: heading bar → SeasonNav row → SeasonalFilterChips pill cloud
// (~28 chips: 18 genres + 6 formats + 3 statuses + sort) → card grid at
// the same 3/4 aspect-ratio + minmax(180px) the real AnimeCard grid uses.
// Pure CSS animation — no motion lib — this file must never slow paint.

import type { CSSProperties } from "react";

const PLACEHOLDER_CARDS = 18;
// Per-chip widths cycle so the pill cloud looks like real genre labels of
// varying length instead of a uniform block. 18 genres + 6 formats + 3
// statuses + 1 sort select ≈ the real SeasonalFilterChips footprint.
const GENRE_CHIP_WIDTHS = [56, 72, 60, 84, 64, 76, 52, 88, 68, 60, 80, 64, 72, 56, 84, 60, 76, 68];
const FILTER_CHIP_WIDTHS = [48, 64, 72, 56, 60, 52, 70, 58, 66];

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

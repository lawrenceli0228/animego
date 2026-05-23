// Streaming fallback for the seasonal grid RSC tree. Shown while
// page.tsx awaits getDict() + the Go API's /seasonal endpoint on cold
// cache. Visual rhythm matches the rendered page: heading bar, season
// nav skeleton, then a 12-card grid sized to the same aspect-ratio the
// real AnimeCard uses (3/4). Pure CSS animation -- no motion lib --
// because this file is the LAST thing we want to slow down.

import type { CSSProperties } from "react";

const PLACEHOLDER_CARDS = 12;

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
  marginBottom: 28,
};

const skeletonBoxStyle = (w: string, h: number): CSSProperties => ({
  background:
    "linear-gradient(90deg, rgba(60,60,66,0.30) 0%, rgba(84,84,88,0.40) 50%, rgba(60,60,66,0.30) 100%)",
  backgroundSize: "200% 100%",
  animation: "seasonalPulse 1.6s ease-in-out infinite",
  borderRadius: 8,
  width: w,
  height: h,
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
};

const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
  gap: 12,
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
        <div style={navRowStyle}>
          <div data-seasonal-pulse style={skeletonBoxStyle("88px", 32)} />
          <div data-seasonal-pulse style={skeletonBoxStyle("240px", 34)} />
          <div data-seasonal-pulse style={skeletonBoxStyle("88px", 32)} />
        </div>
      </div>

      <div style={gridStyle}>
        {Array.from({ length: PLACEHOLDER_CARDS }, (_, i) => (
          <div key={i} data-seasonal-pulse style={cardStyle} aria-hidden />
        ))}
      </div>
    </main>
  );
}

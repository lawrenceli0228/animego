// Streaming fallback for /search. Shown on cold navigation before
// searchParams resolve + Go /api/anime/search returns. The shimmer
// rhythm matches the Phase 4 LandingLoading skeleton so first-paint
// feels consistent across surfaces.

import type { CSSProperties } from "react";

const containerStyle: CSSProperties = {
  paddingTop: 40,
  paddingBottom: 40,
};

const headerSkeletonStyle: CSSProperties = {
  background:
    "linear-gradient(90deg, rgba(60,60,66,0.30) 0%, rgba(84,84,88,0.40) 50%, rgba(60,60,66,0.30) 100%)",
  backgroundSize: "200% 100%",
  animation: "searchPulse 1.6s ease-in-out infinite",
  borderRadius: 4,
  height: 40,
  width: "min(360px, 60vw)",
  marginBottom: 24,
};

const filterRowStyle: CSSProperties = {
  display: "flex",
  gap: 12,
  marginBottom: 20,
};

const inputSkeletonStyle: CSSProperties = {
  background: "rgba(60,60,66,0.30)",
  borderRadius: 9999,
  height: 44,
  width: "min(480px, 70vw)",
  animation: "searchPulse 1.6s ease-in-out infinite",
  backgroundImage:
    "linear-gradient(90deg, rgba(60,60,66,0.30) 0%, rgba(84,84,88,0.40) 50%, rgba(60,60,66,0.30) 100%)",
  backgroundSize: "200% 100%",
};

const chipsRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
  marginBottom: 16,
};

const chipSkeletonStyle = (width: number): CSSProperties => ({
  background:
    "linear-gradient(90deg, rgba(60,60,66,0.30) 0%, rgba(84,84,88,0.40) 50%, rgba(60,60,66,0.30) 100%)",
  backgroundSize: "200% 100%",
  animation: "searchPulse 1.6s ease-in-out infinite",
  borderRadius: 9999,
  height: 24,
  width,
});

const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(5, 1fr)",
  gap: 12,
};

const cardSkeletonStyle: CSSProperties = {
  background:
    "linear-gradient(90deg, rgba(60,60,66,0.30) 0%, rgba(84,84,88,0.40) 50%, rgba(60,60,66,0.30) 100%)",
  backgroundSize: "200% 100%",
  animation: "searchPulse 1.6s ease-in-out infinite",
  borderRadius: 12,
  aspectRatio: "3/4",
};

// Approximate chip widths so the skeleton row visually mirrors the
// real GENRES row (Action, Adventure, Mahou Shoujo, etc. differ in
// pixel width). Keeps cumulative layout shift on swap minimal.
const CHIP_WIDTHS = [56, 72, 64, 56, 56, 64, 60, 96, 64, 56, 64, 96, 64, 60, 96, 60, 88, 68];

export default function SearchLoading() {
  return (
    <div
      className="container"
      style={containerStyle}
      aria-busy="true"
      aria-live="polite"
    >
      <style>{`
        @keyframes searchPulse {
          0%, 100% { background-position: 0% 50%; }
          50%      { background-position: 100% 50%; }
        }
        @media (prefers-reduced-motion: reduce) {
          [data-search-pulse] { animation: none !important; opacity: 0.35; }
        }
        .search-loading-grid {
          grid-template-columns: repeat(5, 1fr);
        }
        @media (max-width: 900px) {
          .search-loading-grid { grid-template-columns: repeat(3, 1fr) !important; }
        }
        @media (max-width: 600px) {
          .search-loading-grid { grid-template-columns: repeat(2, 1fr) !important; }
        }
      `}</style>
      <div data-search-pulse style={headerSkeletonStyle} />
      <div style={filterRowStyle}>
        <div data-search-pulse style={inputSkeletonStyle} />
      </div>
      <div style={chipsRowStyle}>
        {CHIP_WIDTHS.map((w, i) => (
          <div key={i} data-search-pulse style={chipSkeletonStyle(w)} />
        ))}
      </div>
      <div className="search-loading-grid" style={gridStyle}>
        {Array.from({ length: 12 }, (_, i) => (
          <div key={i} data-search-pulse style={cardSkeletonStyle} />
        ))}
      </div>
    </div>
  );
}

// Streaming fallback for /anime/[id] while page.tsx awaits the Go
// /api/anime/:id payload.
//
// Design intent matches legacy DetailSkeleton (client/src/components/common/Skeleton.jsx:76-124):
// ONE block mirroring the real page geometry so the content swap is invisible.
// Banner 400px + 210×300 cover overlapping -80px + meta column at padding-top
// 60 — same numbers page.tsx Hero renders, so layout doesn't shift when the
// real payload lands.

import type { CSSProperties } from "react";

const SHIMMER_BG =
  "linear-gradient(90deg, #1c1c1e 25%, #2c2c2e 50%, #1c1c1e 75%)";

const shimmer = (
  w: number | string,
  h: number,
  extra?: CSSProperties,
): CSSProperties => ({
  width: w,
  height: h,
  background: SHIMMER_BG,
  backgroundSize: "200% 100%",
  animation: "skeletonShimmer 1.4s ease-in-out infinite",
  borderRadius: 4,
  ...extra,
});

export default function AnimeDetailLoading() {
  const bannerOverlay =
    "linear-gradient(to bottom, transparent 0%, transparent 40%, rgba(0,0,0,0.30) 65%, rgba(0,0,0,0.95) 100%)";

  return (
    <main aria-busy="true" aria-live="polite">
      <style>{`
        @keyframes skeletonShimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          [data-skeleton] { animation: none !important; opacity: 0.6; }
        }
      `}</style>

      {/* Banner — same 400px height as the real hero so the cover's
          -80px overlap lands on the same pixel after the swap. */}
      <div
        style={{
          position: "relative",
          height: 400,
          background: SHIMMER_BG,
          backgroundSize: "200% 100%",
          animation: "skeletonShimmer 1.4s ease-in-out infinite",
          overflow: "hidden",
        }}
        data-skeleton
      >
        <div style={{ position: "absolute", inset: 0, background: bannerOverlay }} />
      </div>

      <div
        className="container"
        style={{
          display: "flex",
          gap: 32,
          marginTop: -80,
          position: "relative",
          zIndex: 1,
          paddingBottom: 40,
          flexWrap: "wrap",
        }}
      >
        {/* Cover — exact 210×300 + 12px radius matches Hero S.cover. */}
        <div
          data-skeleton
          style={shimmer(210, 300, { borderRadius: 12, flexShrink: 0 })}
        />

        {/* Meta column — padding-top 60 matches Hero meta div. */}
        <div
          style={{
            flex: 1,
            minWidth: 280,
            paddingTop: 60,
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          {/* Title (clamp 22-36px range; render at 36) */}
          <div data-skeleton style={shimmer("min(60%, 520px)", 36, { borderRadius: 6 })} />
          {/* Native subtitle */}
          <div data-skeleton style={shimmer("min(35%, 280px)", 18)} />
          {/* Badge row: 5 rounded pills matching score + BGM + TV + status + episodes */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 4 }}>
            {[70, 110, 50, 70, 60, 90].map((w, i) => (
              <div
                key={i}
                data-skeleton
                style={shimmer(w, 26, { borderRadius: 9999 })}
              />
            ))}
          </div>
          {/* Meta dot row: studios · source · duration · date */}
          <div data-skeleton style={shimmer("min(55%, 360px)", 14, { marginTop: 6 })} />
          {/* Genre chips */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
            {[64, 82, 56, 74, 88, 60].map((w, i) => (
              <div
                key={i}
                data-skeleton
                style={shimmer(w, 22, { borderRadius: 9999 })}
              />
            ))}
          </div>
          {/* Description lines */}
          <div data-skeleton style={shimmer("min(92%, 760px)", 14, { marginTop: 12 })} />
          <div data-skeleton style={shimmer("min(88%, 720px)", 14 )} />
          <div data-skeleton style={shimmer("min(70%, 560px)", 14)} />
        </div>
      </div>

      <div className="container">
        {/* Action row — matches DetailActions: sub button + share + magnet + play */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 16 }}>
          <div data-skeleton style={shimmer(150, 40, { borderRadius: 8 })} />
          <div data-skeleton style={shimmer(80, 40, { borderRadius: 8 })} />
          <div data-skeleton style={shimmer(96, 40, { borderRadius: 8 })} />
          <div data-skeleton style={shimmer(108, 40, { borderRadius: 8 })} />
        </div>

        {/* Watchers row */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 24 }}>
          <div data-skeleton style={shimmer(28, 28, { borderRadius: "50%" })} />
          <div data-skeleton style={shimmer(70, 12)} />
        </div>

        {/* Characters section — section label + grid of 6 avatar+name pairs */}
        <div data-skeleton style={shimmer(120, 14, { marginTop: 40 })} />
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
            gap: 12,
            marginTop: 16,
          }}
        >
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              style={{ display: "flex", alignItems: "center", gap: 10 }}
            >
              <div
                data-skeleton
                style={shimmer(58, 76, { borderRadius: 4, flexShrink: 0 })}
              />
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
                <div data-skeleton style={shimmer("80%", 13)} />
                <div data-skeleton style={shimmer("50%", 11)} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}

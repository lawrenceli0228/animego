// Streaming fallback for /anime/[id] while page.tsx awaits the Go
// /api/anime/:id payload. Mirrors the LandingLoading visual rhythm
// (dark sections + chapter hue bar + CSS shimmer) so the cold-cache
// frame doesn't flash a blank page on first request after ISR expires.
//
// 5 blocks match the rendered section order:
//   hero | relations | characters | staff | recommendations

import type { CSSProperties } from "react";

const sectionStyle: CSSProperties = {
  position: "relative",
  padding: "clamp(48px, 4vw, 80px) 0",
  borderBottom: "1px solid rgba(84,84,88,0.30)",
  background: "#000",
};

const barStyle = (hue: number, height: number): CSSProperties => ({
  position: "absolute",
  left: 28,
  top: 28,
  width: 3,
  height,
  background: `oklch(62% 0.19 ${hue})`,
  borderRadius: 2,
  boxShadow: `0 0 24px oklch(62% 0.19 ${hue} / 0.55)`,
  opacity: 0.7,
});

const skeletonBoxStyle = (w: string, h: number): CSSProperties => ({
  background:
    "linear-gradient(90deg, rgba(60,60,66,0.30) 0%, rgba(84,84,88,0.40) 50%, rgba(60,60,66,0.30) 100%)",
  backgroundSize: "200% 100%",
  animation: "detailPulse 1.6s ease-in-out infinite",
  borderRadius: 4,
  width: w,
  height: h,
});

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 24,
  paddingLeft: 60,
  paddingTop: 4,
};

// hero / relations / characters / staff / recommendations
const sectionHues = [330, 210, 195, 260, 70];

export default function AnimeDetailLoading() {
  return (
    <main aria-busy="true" aria-live="polite">
      <style>{`
        @keyframes detailPulse {
          0%, 100% { background-position: 0% 50%; }
          50%      { background-position: 100% 50%; }
        }
        @media (prefers-reduced-motion: reduce) {
          [data-detail-pulse] { animation: none !important; opacity: 0.35; }
        }
      `}</style>

      {/* Hero block: banner placeholder + cover + meta column */}
      <section style={{ ...sectionStyle, padding: 0, borderBottom: "none" }}>
        <div data-detail-pulse style={{ ...skeletonBoxStyle("100%", 320), borderRadius: 0 }} />
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
          <div data-detail-pulse style={{ ...skeletonBoxStyle("210px", 300), borderRadius: 12, flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 280, paddingTop: 60, display: "flex", flexDirection: "column", gap: 14 }}>
            <div data-detail-pulse style={skeletonBoxStyle("min(60%, 480px)", 36)} />
            <div data-detail-pulse style={skeletonBoxStyle("min(40%, 320px)", 18)} />
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
              {[64, 80, 56, 96, 72].map((w, i) => (
                <div key={i} data-detail-pulse style={{ ...skeletonBoxStyle(`${w}px`, 24), borderRadius: 9999 }} />
              ))}
            </div>
            <div data-detail-pulse style={skeletonBoxStyle("min(90%, 720px)", 14)} />
            <div data-detail-pulse style={skeletonBoxStyle("min(85%, 680px)", 14)} />
            <div data-detail-pulse style={skeletonBoxStyle("min(70%, 540px)", 14)} />
          </div>
        </div>
      </section>

      {/* Relations / Characters / Staff / Recommendations blocks */}
      {sectionHues.slice(1).map((hue, idx) => (
        <section key={idx} style={sectionStyle}>
          <span style={barStyle(hue, 52)} aria-hidden />
          <div className="container" style={containerStyle}>
            <div data-detail-pulse style={skeletonBoxStyle("10rem", 14)} />
            <div
              style={{
                display: "grid",
                gridTemplateColumns:
                  idx === 0
                    ? "repeat(auto-fill, minmax(260px, 1fr))"
                    : idx === 1
                      ? "repeat(auto-fill, minmax(340px, 1fr))"
                      : idx === 2
                        ? "repeat(auto-fill, minmax(200px, 1fr))"
                        : "repeat(auto-fill, minmax(160px, 1fr))",
                gap: 12,
                marginTop: 8,
              }}
            >
              {Array.from({ length: idx === 3 ? 8 : 6 }).map((_, j) => (
                <div
                  key={j}
                  data-detail-pulse
                  style={skeletonBoxStyle("100%", idx === 3 ? 220 : idx === 1 ? 96 : 64)}
                />
              ))}
            </div>
          </div>
        </section>
      ))}
    </main>
  );
}

// HomePage skeleton: hero block (LCP placeholder) + 6 section bands so
// the layout shift on swap is minimal. Pure CSS shimmer, prefers-reduced-
// motion freezes to flat opacity.

const heroStyle = {
  position: "relative" as const,
  width: "100%",
  height: "clamp(420px, 55vh, 600px)",
  overflow: "hidden",
  background: "#0a0a0a",
};

const sectionStyle = {
  padding: "32px 0 16px",
  borderTop: "1px solid rgba(84,84,88,0.18)",
};

const titleSkeleton = {
  background:
    "linear-gradient(90deg, rgba(60,60,66,0.30) 0%, rgba(84,84,88,0.40) 50%, rgba(60,60,66,0.30) 100%)",
  backgroundSize: "200% 100%",
  animation: "homePulse 1.6s ease-in-out infinite",
  borderRadius: 4,
  width: "min(280px, 50vw)",
  height: 28,
  marginBottom: 16,
};

const labelSkeleton = {
  ...titleSkeleton,
  width: 96,
  height: 12,
  marginBottom: 12,
};

const cardSkeleton = {
  aspectRatio: "3/4" as const,
  background:
    "linear-gradient(90deg, rgba(28,28,30,0.85) 0%, rgba(44,44,46,0.9) 50%, rgba(28,28,30,0.85) 100%)",
  backgroundSize: "200% 100%",
  animation: "homePulse 1.6s ease-in-out infinite",
  borderRadius: 12,
};

const gridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
  gap: 16,
};

export default function HomeLoading() {
  return (
    <main aria-busy="true" aria-live="polite">
      <style>{`
        @keyframes homePulse {
          0%, 100% { background-position: 0% 50%; }
          50%      { background-position: 100% 50%; }
        }
        @media (prefers-reduced-motion: reduce) {
          [data-home-pulse] { animation: none !important; opacity: 0.35; }
        }
      `}</style>

      <div style={heroStyle}>
        <div
          className="container"
          style={{
            position: "relative",
            height: "100%",
            display: "flex",
            alignItems: "center",
          }}
        >
          <div style={{ maxWidth: 560 }}>
            <div data-home-pulse style={{ ...labelSkeleton, width: 120, height: 14 }} />
            <div data-home-pulse style={{ ...titleSkeleton, width: "90%", height: 40, marginBottom: 12 }} />
            <div data-home-pulse style={{ ...titleSkeleton, width: "60%", height: 28, marginBottom: 16 }} />
            <div data-home-pulse style={{ ...titleSkeleton, width: 160, height: 44 }} />
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            display: "flex",
            gap: 8,
          }}
        >
          {[28, 6, 6, 6, 6].map((w, i) => (
            <div key={i} data-home-pulse style={{ ...cardSkeleton, width: w, height: 6, borderRadius: 3, aspectRatio: "unset" }} />
          ))}
        </div>
      </div>

      <div className="container" style={{ paddingTop: 8, paddingBottom: 60 }}>
        {[0, 1, 2, 3, 4, 5].map((idx) => (
          <section key={idx} style={sectionStyle}>
            <div data-home-pulse style={labelSkeleton} />
            <div data-home-pulse style={titleSkeleton} />
            <div style={gridStyle}>
              {[0, 1, 2, 3, 4, 5].map((c) => (
                <div key={c} data-home-pulse style={cardSkeleton} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}

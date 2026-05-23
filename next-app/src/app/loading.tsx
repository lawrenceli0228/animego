// Streaming fallback for the LandingPage RSC tree. Shown while
// page.tsx awaits getDict() + Go API (trending + 3 anime detail) on cold
// cache. Without this, visitors get a blank screen for ~2-3s on the
// first request after revalidate expires.
//
// Visual rhythm matches the section grid so the layout shift on swap is
// minimal. The chapter bars are pure CSS (no motion lib) to keep the
// loading bundle as small as possible -- this is the LAST thing we want
// to slow down.

const sectionStyle = {
  position: "relative" as const,
  padding: "clamp(48px, 4vw, 80px) 0",
  borderBottom: "1px solid rgba(84,84,88,0.30)",
  background: "#000",
};

const barStyle = (hue: number, height: number) => ({
  position: "absolute" as const,
  left: 28,
  top: 28,
  width: 3,
  height,
  background: `oklch(62% 0.19 ${hue})`,
  borderRadius: 2,
  boxShadow: `0 0 24px oklch(62% 0.19 ${hue} / 0.55)`,
  opacity: 0.7,
});

const skeletonBoxStyle = (w: string, h: number) => ({
  background: "linear-gradient(90deg, rgba(60,60,66,0.30) 0%, rgba(84,84,88,0.40) 50%, rgba(60,60,66,0.30) 100%)",
  backgroundSize: "200% 100%",
  animation: "landingPulse 1.6s ease-in-out infinite",
  borderRadius: 4,
  width: w,
  height: h,
});

const sectionHues = [330, 210, 40, 260, 195, 70, 40];

export default function LandingLoading() {
  return (
    <main aria-busy="true" aria-live="polite">
      <style>{`
        @keyframes landingPulse {
          0%, 100% { background-position: 0% 50%; }
          50%      { background-position: 100% 50%; }
        }
        @media (prefers-reduced-motion: reduce) {
          [data-landing-pulse] { animation: none !important; opacity: 0.35; }
        }
      `}</style>
      {sectionHues.map((hue, idx) => (
        <section key={idx} style={sectionStyle}>
          <span style={barStyle(hue, 52)} aria-hidden />
          <div
            className="container"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 24,
              paddingLeft: 60,
              paddingTop: 4,
            }}
          >
            <div data-landing-pulse style={skeletonBoxStyle("12rem", 16)} />
            <div data-landing-pulse style={skeletonBoxStyle("min(640px, 60vw)", 44)} />
            <div data-landing-pulse style={skeletonBoxStyle("min(480px, 50vw)", 14)} />
            {idx === 0 && (
              <div
                data-landing-pulse
                style={{ ...skeletonBoxStyle("100%", 280), marginTop: 24 }}
              />
            )}
          </div>
        </section>
      ))}
    </main>
  );
}

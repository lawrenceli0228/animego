// HomePage skeleton: the hero block (LCP placeholder) and a few section bands,
// laid out on the redesigned homepage's geometry — the same hero height, the
// same gutters, the neutral version of the page ground — so the swap to the
// real page does not jump. Pure CSS shimmer; prefers-reduced-motion freezes it.

const shimmer = {
  background:
    "linear-gradient(90deg, rgba(60,60,66,0.30) 0%, rgba(84,84,88,0.40) 50%, rgba(60,60,66,0.30) 100%)",
  backgroundSize: "200% 100%",
  animation: "homePulse 1.6s ease-in-out infinite",
  borderRadius: 6,
} as const;

const cardShimmer = {
  ...shimmer,
  background:
    "linear-gradient(90deg, rgba(28,28,30,0.85) 0%, rgba(44,44,46,0.9) 50%, rgba(28,28,30,0.85) 100%)",
  backgroundSize: "200% 100%",
  borderRadius: 10,
  aspectRatio: "3/4" as const,
};

export default function HomeLoading() {
  return (
    <main aria-busy="true" aria-live="polite" className="home-skeleton">
      <style>{`
        @keyframes homePulse {
          0%, 100% { background-position: 0% 50%; }
          50%      { background-position: 100% 50%; }
        }
        @media (prefers-reduced-motion: reduce) {
          [data-home-pulse] { animation: none !important; opacity: 0.35; }
        }
        .home-skeleton {
          --gutter: max(clamp(24px, 5.56vw, 80px), calc((100% - 1280px) / 2));
          background: oklch(13% 0 0);
          padding-bottom: 96px;
        }
        .home-skeleton-hero {
          height: 484px;
          padding: 44px var(--gutter) 0;
          display: flex;
          flex-direction: column;
          gap: 20px;
        }
        .home-skeleton-stage { display: flex; align-items: center; gap: 30px; height: 300px; }
        .home-skeleton-cover { width: 196px; height: 276px; flex: none; }
        .home-skeleton-section { margin-top: 80px; padding: 0 var(--gutter); }
        .home-skeleton-grid {
          margin-top: 24px;
          display: grid;
          grid-template-columns: repeat(6, minmax(0, 1fr));
          gap: 28px 20px;
        }
        @media (max-width: 900px) {
          .home-skeleton-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
          .home-skeleton-grid > :nth-child(n + 4) { display: none; }
        }
        @media (max-width: 600px) {
          .home-skeleton { --gutter: 20px; padding-bottom: 44px; }
          .home-skeleton-hero { height: 444px; padding-top: 80px; }
          .home-skeleton-stage { height: 150px; gap: 14px; }
          .home-skeleton-cover { width: 106px; height: 150px; }
          .home-skeleton-section { margin-top: 44px; }
          .home-skeleton-grid { gap: 16px 12px; }
        }
      `}</style>

      <div className="home-skeleton-hero">
        <div data-home-pulse style={{ ...shimmer, width: 180, height: 14 }} />
        <div className="home-skeleton-stage">
          <div data-home-pulse className="home-skeleton-cover" style={{ ...cardShimmer, aspectRatio: "unset" }} />
          <div style={{ flex: 1, maxWidth: 560 }}>
            <div data-home-pulse style={{ ...shimmer, width: "80%", height: 34, marginBottom: 14 }} />
            <div data-home-pulse style={{ ...shimmer, width: "40%", height: 16, marginBottom: 14 }} />
            <div data-home-pulse style={{ ...shimmer, width: "90%", height: 14, marginBottom: 8 }} />
            <div data-home-pulse style={{ ...shimmer, width: "70%", height: 14, marginBottom: 20 }} />
            <div data-home-pulse style={{ ...shimmer, width: 220, height: 40, borderRadius: 999 }} />
          </div>
        </div>
      </div>

      {[0, 1, 2].map((section) => (
        <section key={section} className="home-skeleton-section">
          <div data-home-pulse style={{ ...shimmer, width: 140, height: 18 }} />
          <div className="home-skeleton-grid">
            {[0, 1, 2, 3, 4, 5].map((card) => (
              <div key={card} data-home-pulse style={cardShimmer} />
            ))}
          </div>
        </section>
      ))}
    </main>
  );
}

import { Link } from 'react-router-dom'

/**
 * Featured showcase card shown on the right side of the hero.
 * The tile is a single OKLCH-tinted "poster" card with frozen danmaku overlay —
 * this one visual carries both "海报色身份" and "弹幕同屏" product truths.
 */
const featured = {
  title: '葬送的芙莉莲',
  episodeLabel: '第 18 话',
  score: 9.2,
  hue: 268, // violet-ish, will drive the OKLCH tint
}

const danmaku = [
  { text: '这集画面神了', y: 18, delay: 0 },
  { text: '芙莉莲好可爱', y: 34, delay: 0.9 },
  { text: 'op 又来了泪目', y: 52, delay: 1.8 },
  { text: '这分镜不得不服', y: 70, delay: 2.7 },
]

const s = {
  section: {
    position: 'relative',
    padding: 'clamp(72px, 7vw, 112px) 0 clamp(56px, 6vw, 88px)',
    background: '#000',
    borderBottom: '1px solid rgba(84,84,88,0.30)',
    overflow: 'hidden',
  },
  sectionNum: {
    position: 'absolute',
    top: 28, right: 32,
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    letterSpacing: '0.14em',
    color: 'rgba(235,235,245,0.30)',
    textTransform: 'uppercase',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1.25fr) minmax(0, 1fr)',
    gap: 'clamp(32px, 4vw, 72px)',
    alignItems: 'center',
  },
  eyebrow: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '5px 12px',
    borderRadius: 9999,
    border: '1px solid rgba(84,84,88,0.65)',
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    letterSpacing: '0.08em',
    color: 'rgba(235,235,245,0.60)',
    marginBottom: 28,
  },
  dot: {
    width: 6, height: 6, borderRadius: 9999,
    background: '#30d158',
    boxShadow: '0 0 8px rgba(48,209,88,0.55)',
  },
  h1: {
    fontFamily: "'Sora', sans-serif",
    fontWeight: 800,
    fontSize: 'clamp(2.75rem, 1rem + 6vw, 6.5rem)',
    lineHeight: 0.95,
    letterSpacing: '-0.04em',
    color: '#fff',
    margin: 0,
  },
  h1Period: {
    color: 'oklch(68% 0.2 330)',
    textShadow: '0 0 40px oklch(68% 0.2 330 / 0.55)',
  },
  sub: {
    marginTop: 24,
    maxWidth: 520,
    fontSize: 'clamp(15px, 1vw + 0.5rem, 18px)',
    lineHeight: 1.6,
    color: 'rgba(235,235,245,0.60)',
  },
  ctaRow: {
    marginTop: 36,
    display: 'flex',
    gap: 12,
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  btnPrimary: {
    padding: '14px 26px',
    borderRadius: 10,
    background: '#0a84ff',
    color: '#fff',
    fontWeight: 600,
    fontSize: 15,
    fontFamily: "'DM Sans', sans-serif",
    textDecoration: 'none',
    transition: 'background 150ms var(--ease-out-expo), transform 150ms var(--ease-out-expo)',
    display: 'inline-flex', alignItems: 'center', gap: 8,
  },
  btnGhost: {
    padding: '14px 22px',
    borderRadius: 10,
    background: 'transparent',
    color: 'rgba(235,235,245,0.85)',
    fontWeight: 500,
    fontSize: 15,
    fontFamily: "'DM Sans', sans-serif",
    textDecoration: 'none',
    border: '1px solid rgba(84,84,88,0.65)',
    transition: 'all 150ms var(--ease-out-expo)',
    display: 'inline-flex', alignItems: 'center', gap: 8,
  },
  metaRow: {
    marginTop: 40,
    display: 'flex',
    gap: 24,
    flexWrap: 'wrap',
    fontSize: 12,
    color: 'rgba(235,235,245,0.30)',
    fontFamily: "'JetBrains Mono', monospace",
    letterSpacing: '0.04em',
  },
  showcaseWrap: {
    position: 'relative',
    aspectRatio: '3/4',
    width: '100%',
    maxWidth: 460,
    marginLeft: 'auto',
  },
  showcase: {
    position: 'absolute', inset: 0,
    borderRadius: 20,
    overflow: 'hidden',
    background: `
      radial-gradient(80% 60% at 50% 20%, oklch(52% 0.19 295) 0%, oklch(28% 0.12 295) 50%, oklch(12% 0.04 295) 100%)
    `,
    border: '1px solid rgba(255,255,255,0.06)',
    boxShadow: '0 24px 80px oklch(45% 0.18 295 / 0.25), 0 8px 32px rgba(0,0,0,0.6)',
  },
  showcaseGrain: {
    position: 'absolute', inset: 0,
    backgroundImage: 'radial-gradient(rgba(255,255,255,0.04) 1px, transparent 1px)',
    backgroundSize: '3px 3px',
    mixBlendMode: 'overlay',
    opacity: 0.6,
  },
  showcaseTop: {
    position: 'absolute', top: 18, left: 20, right: 20,
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11, letterSpacing: '0.08em',
    color: 'rgba(255,255,255,0.55)',
  },
  showcaseMeta: {
    position: 'absolute', bottom: 20, left: 20, right: 20,
  },
  showcaseEpisode: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12, letterSpacing: '0.08em',
    color: 'rgba(255,255,255,0.55)',
    marginBottom: 8,
  },
  showcaseTitle: {
    fontFamily: "'Sora', sans-serif",
    fontSize: 32, fontWeight: 800,
    color: '#fff',
    letterSpacing: '-0.02em',
    lineHeight: 1.1,
    marginBottom: 16,
  },
  showcaseScore: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '4px 10px',
    borderRadius: 9999,
    background: 'rgba(0,0,0,0.35)',
    backdropFilter: 'blur(10px)',
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12, fontWeight: 700,
    color: '#ff9f0a',
  },
  danmaku: (y, delay) => ({
    position: 'absolute',
    top: `${y}%`,
    left: 0,
    padding: '4px 10px',
    fontSize: 13,
    color: '#fff',
    fontFamily: "'DM Sans', sans-serif",
    textShadow: '0 1px 2px rgba(0,0,0,0.85)',
    whiteSpace: 'nowrap',
    animation: `danmakuFloat 9s linear ${delay}s infinite`,
    willChange: 'transform',
  }),
}

export default function HeroSection() {
  return (
    <section style={s.section} aria-label="AnimeGo 介绍">
      <style>{`
        @keyframes danmakuFloat {
          0%   { transform: translateX(110%); opacity: 0; }
          6%   { opacity: 1; }
          92%  { opacity: 1; }
          100% { transform: translateX(-110%); opacity: 0; }
        }
        @keyframes floatCard {
          0%, 100% { transform: translateY(0); }
          50%      { transform: translateY(-6px); }
        }
        @media (max-width: 880px) {
          .hero-grid { grid-template-columns: 1fr !important; }
          .hero-showcase { margin: 32px auto 0 !important; max-width: 360px !important; }
        }
        @media (prefers-reduced-motion: reduce) {
          [data-danmaku] { animation: none !important; display: none !important; }
          .hero-float { animation: none !important; }
        }
      `}</style>
      <span style={s.sectionNum} aria-hidden>§01</span>

      <div className="container">
        <div className="hero-grid" style={s.grid}>
          {/* Left: manifesto */}
          <div>
            <span style={s.eyebrow}>
              <span style={s.dot} />
              v1.0.12 · OKLCH 海报色身份
            </span>
            <h1 style={s.h1}>
              追你该追的
              <br />
              那一话<span style={s.h1Period}>。</span>
            </h1>
            <p style={s.sub}>
              一个把封面当主角的动漫站。多源聚合、弹幕同屏、手动选集兜底。
            </p>
            <div style={s.ctaRow}>
              <Link
                to="/"
                style={s.btnPrimary}
                onMouseEnter={(e) => { e.currentTarget.style.background = '#409cff'; e.currentTarget.style.transform = 'translateY(-1px)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = '#0a84ff'; e.currentTarget.style.transform = 'translateY(0)'; }}
              >
                开始追番
                <span aria-hidden>→</span>
              </Link>
              <a
                href="https://github.com/lawrenceli0228/animego"
                target="_blank" rel="noreferrer"
                style={s.btnGhost}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'rgba(235,235,245,0.35)'; e.currentTarget.style.color = '#fff'; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'rgba(84,84,88,0.65)'; e.currentTarget.style.color = 'rgba(235,235,245,0.85)'; }}
              >
                加入社区
              </a>
            </div>
            <div style={s.metaRow}>
              <span>12,480 部番剧</span>
              <span>·</span>
              <span>48 个数据源</span>
              <span>·</span>
              <span>日更 200+</span>
            </div>
          </div>

          {/* Right: featured showcase card */}
          <div className="hero-showcase" style={s.showcaseWrap}>
            <div className="hero-float" style={{ ...s.showcase, animation: 'floatCard 7s ease-in-out infinite' }}>
              <div style={s.showcaseGrain} />
              <div style={s.showcaseTop}>
                <span>当季精选</span>
                <span>{featured.episodeLabel}</span>
              </div>

              {/* Frozen danmaku overlay */}
              {danmaku.map((d, i) => (
                <span key={i} data-danmaku="" style={s.danmaku(d.y, d.delay)}>{d.text}</span>
              ))}

              <div style={s.showcaseMeta}>
                <div style={s.showcaseEpisode}>Ep.18 · 2026 春</div>
                <h3 style={s.showcaseTitle}>{featured.title}</h3>
                <span style={s.showcaseScore}>★ {featured.score.toFixed(1)}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

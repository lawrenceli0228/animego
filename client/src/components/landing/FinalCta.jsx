import { Link } from 'react-router-dom'

/**
 * Left-aligned editorial closer.
 * A 3px OKLCH gradient bar — interpolating all four chapter hues (330/210/155/40)
 * — runs across the section top, making this the "index page" callback
 * to the full poster-color identity established in StatsRow and FeaturesBento.
 */

const s = {
  section: {
    position: 'relative',
    padding: 'clamp(96px, 10vw, 144px) 0 clamp(72px, 8vw, 112px)',
    overflow: 'hidden',
    background: '#000',
    borderTop: '1px solid rgba(84,84,88,0.30)',
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
  chapterBar: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    height: 3,
    background: `linear-gradient(90deg,
      oklch(62% 0.19 330) 0%,
      oklch(62% 0.19 210) 33%,
      oklch(62% 0.19 155) 66%,
      oklch(62% 0.19 40) 100%)`,
    opacity: 0.85,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)',
    gap: 'clamp(32px, 5vw, 96px)',
    alignItems: 'end',
  },
  eyebrow: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12,
    letterSpacing: '0.12em',
    color: 'rgba(235,235,245,0.30)',
    textTransform: 'uppercase',
    marginBottom: 20,
  },
  title: {
    fontFamily: "'Sora', sans-serif",
    fontSize: 'clamp(3rem, 1rem + 5.5vw, 6rem)',
    fontWeight: 800,
    color: '#fff',
    letterSpacing: '-0.04em',
    lineHeight: 0.98,
    margin: 0,
  },
  period: {
    color: 'oklch(68% 0.2 40)',
    textShadow: '0 0 40px oklch(68% 0.2 40 / 0.5)',
  },
  rightCol: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 28,
    paddingBottom: 12,
  },
  sub: {
    fontFamily: "'DM Sans', sans-serif",
    fontSize: 16,
    color: 'rgba(235,235,245,0.60)',
    lineHeight: 1.65,
    maxWidth: '38ch',
  },
  btn: {
    display: 'inline-flex', alignItems: 'center', gap: 10,
    padding: '16px 30px',
    borderRadius: 10,
    background: '#fff',
    color: '#000',
    fontFamily: "'DM Sans', sans-serif",
    fontSize: 15, fontWeight: 700,
    textDecoration: 'none',
    transition: 'transform 200ms var(--ease-out-expo), box-shadow 200ms var(--ease-out-expo)',
  },
  metaRow: {
    marginTop: 72,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 16,
    paddingTop: 24,
    borderTop: '1px solid rgba(84,84,88,0.30)',
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    color: 'rgba(235,235,245,0.30)',
    letterSpacing: '0.08em',
  },
}

export default function FinalCta() {
  return (
    <section style={s.section} aria-label="开始使用">
      <style>{`
        @media (max-width: 880px) {
          .finalcta-grid { grid-template-columns: 1fr !important; gap: 40px !important; align-items: start !important; }
          .finalcta-title { font-size: clamp(2.75rem, 1rem + 7vw, 4.5rem) !important; }
        }
      `}</style>
      <div style={s.chapterBar} aria-hidden />
      <span style={s.sectionNum} aria-hidden>§08</span>

      <div className="container">
        <div className="finalcta-grid" style={s.grid}>
          <div>
            <div style={s.eyebrow}>End of Issue · 开始追番</div>
            <h2 className="finalcta-title" style={s.title}>
              这周末的番,
              <br />
              替你备好了<span style={s.period}>。</span>
            </h2>
          </div>

          <div style={s.rightCol}>
            <p style={s.sub}>
              进入首页,开始追这一季 —— 不需要注册,不需要会员,一张封面就是一部番的开始。
            </p>
            <Link
              to="/"
              style={s.btn}
              onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 12px 32px rgba(255,255,255,0.12)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = 'none'; }}
            >
              开始追番
              <span aria-hidden>→</span>
            </Link>
          </div>
        </div>

        <div style={s.metaRow}>
          <span>AnimeGo · v1.0.12</span>
          <span>维护模式 · 2026 春</span>
          <span>§ 01 ─ 08</span>
        </div>
      </div>
    </section>
  )
}

import { Link } from 'react-router-dom'
import { useState, useRef } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { useLang } from '../../context/LanguageContext'
import { pickTitle } from '../../utils/formatters'

/**
 * §01 · Hero
 * - Title reveals word-by-word with spring (stiffness 120 / damping 18).
 * - Showcase card uses a real trending poster (passed via `poster` prop),
 *   layered with an OKLCH wash for color identity continuity.
 * - Custom label cursor follows the pointer inside the showcase.
 * - Decorative "danmaku trails" fly across the hero backdrop.
 */
const FALLBACK_HUE = 330

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
  bgTrail: (top, delay, duration, width) => ({
    position: 'absolute',
    top: `${top}%`,
    left: '-10%',
    height: 1,
    width,
    background: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.22) 50%, transparent 100%)',
    animation: `heroTrail ${duration}s linear ${delay}s infinite`,
    pointerEvents: 'none',
  }),
  sectionNum: {
    position: 'absolute',
    top: 28, right: 32,
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    letterSpacing: '0.14em',
    color: 'rgba(235,235,245,0.30)',
    textTransform: 'uppercase',
    zIndex: 2,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1.25fr) minmax(0, 1fr)',
    gap: 'clamp(32px, 4vw, 72px)',
    alignItems: 'center',
    position: 'relative',
    zIndex: 1,
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
  // Lang-conditional sizing: EN words are wider, so we clamp smaller and
  // tighten letter-spacing to keep the headline from overflowing the column.
  h1: (lang) => ({
    fontFamily: "'Sora', sans-serif",
    fontWeight: 800,
    fontSize: lang === 'en'
      ? 'clamp(2.25rem, 1rem + 4.5vw, 5rem)'
      : 'clamp(2.75rem, 1rem + 6vw, 6.5rem)',
    lineHeight: 0.95,
    letterSpacing: lang === 'en' ? '-0.035em' : '-0.04em',
    color: '#fff',
    margin: 0,
  }),
  word: {
    display: 'inline-block',
  },
  // EN uses a U+002E period — scale it up so it reads as punctuation,
  // not a rendering bug, and keep the OKLCH hero accent glow.
  h1Period: (lang) => ({
    display: 'inline-block',
    color: 'oklch(68% 0.2 330)',
    textShadow: '0 0 40px oklch(68% 0.2 330 / 0.55)',
    fontSize: lang === 'en' ? '1.3em' : undefined,
    marginLeft: lang === 'en' ? '0.05em' : undefined,
  }),
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
  showcase: (hue) => ({
    position: 'absolute', inset: 0,
    borderRadius: 20,
    overflow: 'hidden',
    background: `oklch(12% 0.04 ${hue})`,
    border: '1px solid rgba(255,255,255,0.06)',
    boxShadow: `0 24px 80px oklch(45% 0.18 ${hue} / 0.25), 0 8px 32px rgba(0,0,0,0.6)`,
    cursor: 'none',
  }),
  posterImg: {
    position: 'absolute', inset: 0,
    width: '100%', height: '100%',
    objectFit: 'cover',
    display: 'block',
  },
  posterTint: (hue) => ({
    position: 'absolute', inset: 0,
    background: `linear-gradient(180deg, oklch(45% 0.18 ${hue} / 0.12) 0%, oklch(18% 0.08 ${hue} / 0.28) 100%)`,
    mixBlendMode: 'soft-light',
    pointerEvents: 'none',
  }),
  coverWash: {
    position: 'absolute',
    left: 0, right: 0, bottom: 0,
    height: '45%',
    background: 'linear-gradient(to top, rgba(0,0,0,0.82) 0%, rgba(0,0,0,0.35) 50%, transparent 100%)',
    pointerEvents: 'none',
  },
  showcaseGrain: {
    position: 'absolute', inset: 0,
    backgroundImage: 'radial-gradient(rgba(255,255,255,0.04) 1px, transparent 1px)',
    backgroundSize: '3px 3px',
    mixBlendMode: 'overlay',
    opacity: 0.5,
    pointerEvents: 'none',
  },
  showcaseTop: {
    position: 'absolute', top: 18, left: 20, right: 20,
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11, letterSpacing: '0.08em',
    color: 'rgba(255,255,255,0.75)',
    pointerEvents: 'none',
  },
  showcaseMeta: {
    position: 'absolute', bottom: 20, left: 20, right: 20,
    pointerEvents: 'none',
  },
  showcaseEpisode: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12, letterSpacing: '0.08em',
    color: 'rgba(255,255,255,0.60)',
    marginBottom: 8,
  },
  showcaseTitle: {
    fontFamily: "'Sora', sans-serif",
    fontSize: 32, fontWeight: 800,
    color: '#fff',
    letterSpacing: '-0.02em',
    lineHeight: 1.1,
    marginBottom: 16,
    textShadow: '0 2px 24px rgba(0,0,0,0.6)',
  },
  showcaseScore: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '4px 10px',
    borderRadius: 9999,
    background: 'rgba(0,0,0,0.4)',
    backdropFilter: 'blur(10px)',
    WebkitBackdropFilter: 'blur(10px)',
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
    pointerEvents: 'none',
  }),
  cursorLabel: (visible, x, y) => ({
    position: 'absolute',
    left: x, top: y,
    transform: `translate(12px, 12px) scale(${visible ? 1 : 0.6})`,
    padding: '4px 10px',
    borderRadius: 9999,
    background: 'rgba(0,0,0,0.85)',
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    border: '1px solid rgba(255,255,255,0.18)',
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10,
    letterSpacing: '0.08em',
    color: '#fff',
    opacity: visible ? 1 : 0,
    pointerEvents: 'none',
    transition: 'opacity 180ms var(--ease-out-expo), transform 180ms var(--ease-out-expo)',
    zIndex: 20,
    whiteSpace: 'nowrap',
  }),
}

function AnimatedWord({ children, delay, reduced }) {
  if (reduced) return <span style={s.word}>{children}</span>
  return (
    <motion.span
      style={s.word}
      initial={{ opacity: 0, y: '0.4em', filter: 'blur(8px)' }}
      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      transition={{ type: 'spring', stiffness: 120, damping: 18, mass: 0.8, delay }}
    >
      {children}
    </motion.span>
  )
}

function Showcase({ reduced, poster }) {
  const { lang, t } = useLang()
  const [cursor, setCursor] = useState({ x: 0, y: 0, on: false })
  const ref = useRef(null)

  const onMove = (e) => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    setCursor({ x: e.clientX - r.left, y: e.clientY - r.top, on: true })
  }
  const onLeave = () => setCursor((c) => ({ ...c, on: false }))

  const hue = poster?.posterAccent ?? FALLBACK_HUE
  const title = (poster ? pickTitle(poster, lang) : '') || '—'
  const score = poster?.averageScore != null ? (poster.averageScore / 10).toFixed(1) : null
  const epUnit = t('landing.hero.episodeUnit')
  const trendingFallback = t('landing.hero.trendingFallback')

  return (
    <div
      ref={ref}
      style={s.showcase(hue)}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
    >
      {poster?.coverImageUrl ? (
        <img
          src={poster.coverImageUrl}
          alt={title}
          style={s.posterImg}
          loading="eager"
          fetchPriority="high"
        />
      ) : null}
      <div style={s.posterTint(hue)} aria-hidden />
      <div style={s.coverWash} aria-hidden />
      <div style={s.showcaseGrain} aria-hidden />

      <div style={s.showcaseTop}>
        <span>{t('landing.hero.showcaseLabel')}</span>
        <span>{poster?.format || 'TV'}</span>
      </div>

      {danmaku.map((d, i) => (
        <span key={i} data-danmaku="" style={s.danmaku(d.y, d.delay)}>{d.text}</span>
      ))}

      <div style={s.showcaseMeta}>
        <div style={s.showcaseEpisode}>
          {poster?.seasonYear ? `${poster.seasonYear} · ` : ''}
          {poster?.episodes
            ? (lang === 'en' ? `${poster.episodes} ${epUnit}` : `${poster.episodes} ${epUnit}`)
            : trendingFallback}
        </div>
        <h3 style={s.showcaseTitle}>{title}</h3>
        {score ? <span style={s.showcaseScore}>★ {score}</span> : null}
      </div>

      <span style={s.cursorLabel(cursor.on, cursor.x, cursor.y)} aria-hidden>
        {t('landing.hero.cursorLabel')}
      </span>
    </div>
  )
}

export default function HeroSection({ poster }) {
  const reduced = useReducedMotion()
  const { lang, t } = useLang()
  const base = 0.25
  // EN has fewer words per line than ZH characters; a larger step per word
  // preserves the same total reveal duration and rhythm.
  const step = lang === 'en' ? 0.08 : 0.06

  const titleLine1 = t('landing.hero.titleLine1')
  const titleLine2 = t('landing.hero.titleLine2')
  const period = t('landing.hero.period')
  const line1 = Array.isArray(titleLine1) ? titleLine1 : [titleLine1]
  const line2 = Array.isArray(titleLine2) ? titleLine2 : [titleLine2]

  // Per-word space: in EN we need real spaces between words; in ZH, characters abut.
  const sep = lang === 'en' ? ' ' : ''

  return (
    <section style={s.section} aria-label={t('landing.docTitle')}>
      <style>{`
        @keyframes danmakuFloat {
          0%   { transform: translateX(110%); opacity: 0; }
          6%   { opacity: 1; }
          92%  { opacity: 1; }
          100% { transform: translateX(-110%); opacity: 0; }
        }
        @keyframes heroTrail {
          0%   { transform: translateX(0); opacity: 0; }
          8%   { opacity: 1; }
          92%  { opacity: 1; }
          100% { transform: translateX(130vw); opacity: 0; }
        }
        @media (max-width: 880px) {
          .hero-grid { grid-template-columns: 1fr !important; }
          .hero-showcase { margin: 32px auto 0 !important; max-width: 360px !important; }
        }
        @media (prefers-reduced-motion: reduce) {
          [data-danmaku] { animation: none !important; display: none !important; }
          .hero-trail { display: none !important; }
        }
      `}</style>

      <span className="hero-trail" style={s.bgTrail(12, 0,    16, '180px')} aria-hidden />
      <span className="hero-trail" style={s.bgTrail(28, 5,    22, '140px')} aria-hidden />
      <span className="hero-trail" style={s.bgTrail(64, 2.5,  19, '200px')} aria-hidden />
      <span className="hero-trail" style={s.bgTrail(82, 8,    24, '160px')} aria-hidden />

      <span style={s.sectionNum} aria-hidden>§01</span>

      <div className="container">
        <div className="hero-grid" style={s.grid}>
          <div>
            <span style={s.eyebrow}>
              <span style={s.dot} />
              {t('landing.hero.eyebrow')}
            </span>
            <h1 style={s.h1(lang)}>
              {line1.map((w, i) => (
                <span key={`a-${i}`}>
                  <AnimatedWord delay={base + i * step} reduced={reduced}>
                    {w}
                  </AnimatedWord>
                  {sep && i < line1.length - 1 ? sep : ''}
                </span>
              ))}
              <br />
              {line2.map((w, i) => (
                <span key={`b-${i}`}>
                  <AnimatedWord
                    delay={base + (line1.length + i) * step}
                    reduced={reduced}
                  >
                    {w}
                  </AnimatedWord>
                  {sep && i < line2.length - 1 ? sep : ''}
                </span>
              ))}
              <motion.span
                style={s.h1Period(lang)}
                initial={reduced ? false : { opacity: 0, scale: 0.6 }}
                animate={reduced ? undefined : { opacity: 1, scale: 1 }}
                transition={{
                  type: 'spring', stiffness: 180, damping: 14,
                  delay: base + (line1.length + line2.length) * step,
                }}
              >
                {period}
              </motion.span>
            </h1>
            <motion.p
              style={s.sub}
              initial={reduced ? false : { opacity: 0, y: 12 }}
              animate={reduced ? undefined : { opacity: 1, y: 0 }}
              transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1], delay: base + 0.65 }}
            >
              {t('landing.hero.sub')}
            </motion.p>
            <motion.div
              style={s.ctaRow}
              initial={reduced ? false : { opacity: 0, y: 12 }}
              animate={reduced ? undefined : { opacity: 1, y: 0 }}
              transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1], delay: base + 0.78 }}
            >
              <Link
                to="/"
                style={s.btnPrimary}
                onMouseEnter={(e) => { e.currentTarget.style.background = '#409cff'; e.currentTarget.style.transform = 'translateY(-1px)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = '#0a84ff'; e.currentTarget.style.transform = 'translateY(0)'; }}
              >
                {t('landing.hero.ctaPrimary')}
                <span aria-hidden>→</span>
              </Link>
              <a
                href="https://github.com/lawrenceli0228/animego"
                target="_blank" rel="noreferrer"
                style={s.btnGhost}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'rgba(235,235,245,0.35)'; e.currentTarget.style.color = '#fff'; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'rgba(84,84,88,0.65)'; e.currentTarget.style.color = 'rgba(235,235,245,0.85)'; }}
              >
                {t('landing.hero.ctaSecondary')}
              </a>
            </motion.div>
            <div style={s.metaRow}>
              <span>{t('landing.hero.metaCount')}</span>
              <span>·</span>
              <span>{t('landing.hero.metaSources')}</span>
              <span>·</span>
              <span>{t('landing.hero.metaDaily')}</span>
            </div>
          </div>

          <motion.div
            className="hero-showcase"
            style={s.showcaseWrap}
            initial={reduced ? false : { opacity: 0, y: 20, scale: 0.96 }}
            animate={reduced ? undefined : { opacity: 1, y: 0, scale: 1 }}
            transition={{ type: 'spring', stiffness: 90, damping: 20, delay: 0.4 }}
          >
            <Showcase reduced={reduced} poster={poster} />
          </motion.div>
        </div>
      </div>
    </section>
  )
}

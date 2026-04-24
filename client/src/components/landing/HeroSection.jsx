/**
 * §01 · Hero
 * - Title reveals word-by-word with spring (stiffness 120 / damping 18).
 * - Showcase card uses a real trending poster (passed via `poster` prop),
 *   framed with CornerBrackets + mono readout for HUD-bezel identity.
 * - Custom label cursor follows the pointer inside the showcase.
 * - HUD upgrade: shared SectionNum, HUD-framed CTAs replacing iOS system blue
 *   pill; eyebrow dot re-keyed from iOS green to section hue 330 magenta.
 */

import { Link } from 'react-router-dom'
import { useState, useRef } from 'react'
import { motion as Motion, useReducedMotion } from 'motion/react'
import { useLang } from '../../context/LanguageContext'
import { pickTitle } from '../../utils/formatters'
import { mono } from './shared/hud-tokens'
import { SectionNum, CornerBrackets } from './shared/hud'

const SECTION_HUE = 330
// Harmony partners — see Phase A palette plan.
//   P2 Cold Verdigris → ghost-CTA accent (cool counterbalance to magenta)
//   P3 Paper Cream    → meta-row separators (warm whisper)
const HUE_GHOST = 175
const HUE_CREAM = 80

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
    border: `1px solid oklch(62% 0.19 ${SECTION_HUE} / 0.35)`,
    background: 'transparent',
    ...mono,
    fontSize: 11,
    letterSpacing: '0.10em',
    color: `oklch(82% 0.15 ${SECTION_HUE})`,
    marginBottom: 28,
  },
  dot: {
    width: 6, height: 6, borderRadius: 9999,
    background: `oklch(62% 0.19 ${SECTION_HUE})`,
    boxShadow: `0 0 10px oklch(62% 0.19 ${SECTION_HUE} / 0.7)`,
    animation: 'hudBlink 2.2s var(--ease-out-expo) infinite',
  },
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
  h1Period: (lang) => ({
    display: 'inline-block',
    color: `oklch(68% 0.2 ${SECTION_HUE})`,
    textShadow: `0 0 40px oklch(68% 0.2 ${SECTION_HUE} / 0.55)`,
    fontSize: lang === 'en' ? '1.3em' : undefined,
    marginLeft: lang === 'en' ? '0.05em' : undefined,
  }),
  sub: {
    marginTop: 24,
    maxWidth: 520,
    fontFamily: "'DM Sans', sans-serif",
    fontSize: 'clamp(15px, 1vw + 0.5rem, 18px)',
    lineHeight: 1.6,
    color: 'rgba(235,235,245,0.60)',
  },
  ctaRow: {
    marginTop: 36,
    display: 'flex',
    gap: 14,
    flexWrap: 'wrap',
    alignItems: 'stretch',
  },
  btnPrimary: {
    position: 'relative',
    display: 'inline-flex',
    flexDirection: 'column',
    gap: 4,
    padding: '14px 26px 14px 22px',
    borderRadius: 4,
    textDecoration: 'none',
    border: `1px solid oklch(62% 0.19 ${SECTION_HUE} / 0.55)`,
    background: `oklch(22% 0.10 ${SECTION_HUE} / 0.55)`,
    transition: 'border-color 200ms var(--ease-out-expo), background 200ms var(--ease-out-expo), transform 200ms var(--ease-out-expo)',
  },
  btnPrimaryLabel: {
    ...mono,
    fontSize: 10,
    letterSpacing: '0.16em',
    color: `oklch(82% 0.15 ${SECTION_HUE})`,
    textTransform: 'uppercase',
  },
  btnPrimaryMain: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 12,
    fontFamily: "'Sora', sans-serif",
    fontSize: 16,
    fontWeight: 700,
    color: '#fff',
    letterSpacing: '-0.01em',
  },
  btnPrimaryArrow: {
    ...mono,
    fontSize: 14,
    color: `oklch(82% 0.15 ${SECTION_HUE})`,
    transition: 'transform 200ms var(--ease-out-expo)',
  },
  btnGhost: {
    display: 'inline-flex', alignItems: 'center', gap: 10,
    padding: '14px 22px',
    borderRadius: 4,
    background: 'transparent',
    color: `oklch(82% 0.07 ${HUE_GHOST})`,
    ...mono,
    fontSize: 13,
    letterSpacing: '0.08em',
    textDecoration: 'none',
    border: `1px solid oklch(62% 0.09 ${HUE_GHOST} / 0.45)`,
    transition: 'border-color 150ms var(--ease-out-expo), color 150ms var(--ease-out-expo), background 150ms var(--ease-out-expo)',
    textTransform: 'uppercase',
  },
  metaRow: {
    marginTop: 40,
    display: 'flex',
    gap: 20,
    flexWrap: 'wrap',
    alignItems: 'center',
    ...mono,
    fontSize: 11,
    color: 'rgba(235,235,245,0.42)',
    letterSpacing: '0.06em',
  },
  metaSep: {
    color: `oklch(90% 0.06 ${HUE_CREAM} / 0.45)`,
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
    borderRadius: 12,
    overflow: 'hidden',
    background: `oklch(12% 0.04 ${hue})`,
    border: '1px solid rgba(255,255,255,0.08)',
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
    ...mono,
    fontSize: 11, letterSpacing: '0.10em',
    color: 'rgba(255,255,255,0.80)',
    pointerEvents: 'none',
    textTransform: 'uppercase',
  },
  showcaseTopLeft: {
    display: 'inline-flex', alignItems: 'center', gap: 8,
  },
  showcaseTopDot: (hue) => ({
    width: 6, height: 6, borderRadius: 9999,
    background: `oklch(62% 0.19 ${hue})`,
    boxShadow: `0 0 8px oklch(62% 0.19 ${hue} / 0.7)`,
    animation: 'hudBlink 2.2s var(--ease-out-expo) infinite',
  }),
  showcaseMeta: {
    position: 'absolute', bottom: 20, left: 20, right: 20,
    pointerEvents: 'none',
  },
  showcaseEpisode: {
    ...mono,
    fontSize: 11, letterSpacing: '0.10em',
    color: 'rgba(255,255,255,0.60)',
    marginBottom: 8,
    textTransform: 'uppercase',
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
  showcaseScore: (hue) => ({
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '4px 10px',
    borderRadius: 3,
    background: 'rgba(0,0,0,0.55)',
    backdropFilter: 'blur(10px)',
    WebkitBackdropFilter: 'blur(10px)',
    border: `1px solid oklch(62% 0.19 ${hue} / 0.40)`,
    ...mono,
    fontSize: 12, fontWeight: 700,
    color: `oklch(82% 0.15 ${hue})`,
  }),
  danmaku: (y, delay) => ({
    position: 'absolute',
    top: `${y}%`,
    left: 0,
    padding: '4px 10px',
    fontFamily: "'DM Sans', sans-serif",
    fontSize: 13,
    color: '#fff',
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
    borderRadius: 3,
    background: 'rgba(0,0,0,0.85)',
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    border: `1px solid oklch(62% 0.19 ${SECTION_HUE} / 0.50)`,
    ...mono,
    fontSize: 10,
    letterSpacing: '0.10em',
    color: '#fff',
    opacity: visible ? 1 : 0,
    pointerEvents: 'none',
    transition: 'opacity 180ms var(--ease-out-expo), transform 180ms var(--ease-out-expo)',
    zIndex: 20,
    whiteSpace: 'nowrap',
    textTransform: 'uppercase',
  }),
}

function AnimatedWord({ children, delay, reduced }) {
  if (reduced) return <span style={s.word}>{children}</span>
  return (
    <Motion.span
      style={s.word}
      initial={{ opacity: 0, y: '0.4em', filter: 'blur(8px)' }}
      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      transition={{ type: 'spring', stiffness: 120, damping: 18, mass: 0.8, delay }}
    >
      {children}
    </Motion.span>
  )
}

function Showcase({ poster }) {
  const { lang, t } = useLang()
  const [cursor, setCursor] = useState({ x: 0, y: 0, on: false })
  const ref = useRef(null)

  const onMove = (e) => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    setCursor({ x: e.clientX - r.left, y: e.clientY - r.top, on: true })
  }
  const onLeave = () => setCursor((c) => ({ ...c, on: false }))

  const hue = poster?.posterAccent ?? SECTION_HUE
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

      <CornerBrackets inset={10} size={10} opacity={0.55} />

      <div style={s.showcaseTop}>
        <span style={s.showcaseTopLeft}>
          <span style={s.showcaseTopDot(hue)} className="hud-blink" aria-hidden />
          {t('landing.hero.showcaseLabel')}
        </span>
        <span>{poster?.format || 'TV'}</span>
      </div>

      {danmaku.map((d, i) => (
        <span key={i} data-danmaku="" style={s.danmaku(d.y, d.delay)}>{d.text}</span>
      ))}

      <div style={s.showcaseMeta}>
        <div style={s.showcaseEpisode}>
          {poster?.seasonYear ? `${poster.seasonYear} · ` : ''}
          {poster?.episodes ? `${poster.episodes} ${epUnit}` : trendingFallback}
        </div>
        <p style={s.showcaseTitle}>{title}</p>
        {score ? <span style={s.showcaseScore(hue)}>★ {score}</span> : null}
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
  const step = lang === 'en' ? 0.08 : 0.06

  const titleLine1 = t('landing.hero.titleLine1')
  const titleLine2 = t('landing.hero.titleLine2')
  const period = t('landing.hero.period')
  const line1 = Array.isArray(titleLine1) ? titleLine1 : [titleLine1]
  const line2 = Array.isArray(titleLine2) ? titleLine2 : [titleLine2]
  const sep = lang === 'en' ? ' ' : ''

  return (
    <section style={s.section} aria-labelledby="hero-heading">
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
        .hero-btn-primary:hover {
          border-color: oklch(72% 0.19 ${SECTION_HUE} / 0.85) !important;
          background: oklch(28% 0.12 ${SECTION_HUE} / 0.70) !important;
          transform: translateY(-1px);
        }
        .hero-btn-primary:hover .hero-btn-arrow { transform: translateX(4px); }
        .hero-btn-primary:focus-visible,
        .hero-btn-ghost:focus-visible {
          outline: 2px solid oklch(62% 0.19 ${SECTION_HUE});
          outline-offset: 3px;
        }
        .hero-btn-ghost:hover {
          border-color: oklch(72% 0.10 ${HUE_GHOST} / 0.85) !important;
          color: oklch(92% 0.06 ${HUE_GHOST}) !important;
          background: oklch(22% 0.05 ${HUE_GHOST} / 0.35) !important;
        }
        @media (prefers-reduced-motion: reduce) {
          [data-danmaku] { animation: none !important; display: none !important; }
          .hero-trail { display: none !important; }
          .hero-btn-primary:hover { transform: none !important; }
          .hero-btn-primary:hover .hero-btn-arrow { transform: none !important; }
        }
      `}</style>

      <span className="hero-trail" style={s.bgTrail(12, 0,    16, '180px')} aria-hidden />
      <span className="hero-trail" style={s.bgTrail(28, 5,    22, '140px')} aria-hidden />
      <span className="hero-trail" style={s.bgTrail(64, 2.5,  19, '200px')} aria-hidden />
      <span className="hero-trail" style={s.bgTrail(82, 8,    24, '160px')} aria-hidden />

      <SectionNum n="01" />

      <div className="container">
        <div className="hero-grid" style={s.grid}>
          <div>
            <span style={s.eyebrow}>
              <span style={s.dot} className="hud-blink" aria-hidden />
              {t('landing.hero.eyebrow')}
            </span>
            <h1 id="hero-heading" style={s.h1(lang)}>
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
              <Motion.span
                style={s.h1Period(lang)}
                initial={reduced ? false : { opacity: 0, scale: 0.6 }}
                animate={reduced ? undefined : { opacity: 1, scale: 1 }}
                transition={{
                  type: 'spring', stiffness: 180, damping: 14,
                  delay: base + (line1.length + line2.length) * step,
                }}
              >
                {period}
              </Motion.span>
            </h1>
            <Motion.p
              style={s.sub}
              initial={reduced ? false : { opacity: 0, y: 12 }}
              animate={reduced ? undefined : { opacity: 1, y: 0 }}
              transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1], delay: base + 0.65 }}
            >
              {t('landing.hero.sub')}
            </Motion.p>
            <Motion.div
              style={s.ctaRow}
              initial={reduced ? false : { opacity: 0, y: 12 }}
              animate={reduced ? undefined : { opacity: 1, y: 0 }}
              transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1], delay: base + 0.78 }}
            >
              <Link to="/" className="hero-btn-primary" style={s.btnPrimary}>
                <span style={s.btnPrimaryLabel} aria-hidden="true">[ START ]</span>
                <span style={s.btnPrimaryMain}>
                  {t('landing.hero.ctaPrimary')}
                  <span className="hero-btn-arrow" style={s.btnPrimaryArrow} aria-hidden>→</span>
                </span>
              </Link>
              <a
                href="https://github.com/lawrenceli0228/animego"
                target="_blank" rel="noreferrer"
                className="hero-btn-ghost"
                style={s.btnGhost}
              >
                {t('landing.hero.ctaSecondary')}
                <span aria-hidden>↗</span>
              </a>
            </Motion.div>
            <div style={s.metaRow}>
              <span>{t('landing.hero.metaCount')}</span>
              <span style={s.metaSep}>·</span>
              <span>{t('landing.hero.metaSources')}</span>
              <span style={s.metaSep}>·</span>
              <span>{t('landing.hero.metaDaily')}</span>
            </div>
          </div>

          <Motion.div
            className="hero-showcase"
            style={s.showcaseWrap}
            initial={reduced ? false : { opacity: 0, y: 20, scale: 0.96 }}
            animate={reduced ? undefined : { opacity: 1, y: 0, scale: 1 }}
            transition={{ type: 'spring', stiffness: 90, damping: 20, delay: 0.4 }}
          >
            <Showcase poster={poster} />
          </Motion.div>
        </div>
      </div>
    </section>
  )
}

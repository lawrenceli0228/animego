/**
 * §04 — Seven things, done on purpose.
 * Asymmetric 12-col bento: hero band (7+5, row-span 2), mid shelf (4+4+4), bottom (6+6).
 * Each card has a chapter-bar lead-in, staggered entrance, hover spotlight, and a hue-scoped
 * visual that doubles as product proof (OKLCH readouts, live counters, failover logs).
 */

import { motion, useReducedMotion } from 'motion/react'
import { useLang } from '../../context/LanguageContext'
import {
  PosterVisual,
  DanmakuVisual,
  TorrentVisual,
  ManualVisual,
  ResumeVisual,
  ScheduleVisual,
  DropVisual,
} from './features/visuals'

const featureShape = [
  { key: 'f1', size: 'heroL', hue: 330, visual: 'poster',   hasCta: true  },
  { key: 'f2', size: 'heroR', hue: 210, visual: 'danmaku',  hasCta: false },
  { key: 'f3', size: 'md',    hue: 155, visual: 'multi',    hasCta: true  },
  { key: 'f4', size: 'md',    hue: 40,  visual: 'manual',   hasCta: true  },
  { key: 'f5', size: 'md',    hue: 260, visual: 'resume',   hasCta: true  },
  { key: 'f6', size: 'lg',    hue: 195, visual: 'schedule', hasCta: true  },
  { key: 'f7', size: 'lg',    hue: 70,  visual: 'drop',     hasCta: true  },
]

const ENTRANCE_DELAYS = [0, 0.08, 0.18, 0.24, 0.30, 0.38, 0.44]

const s = {
  section: {
    position: 'relative',
    padding: 'clamp(80px, 7vw, 120px) 0',
    background: '#000',
    overflow: 'hidden',
  },
  colorBand: {
    position: 'absolute',
    top: -120, right: -120,
    width: 640, height: 640,
    background: 'radial-gradient(50% 50% at 50% 50%, oklch(32% 0.18 330 / 0.28) 0%, transparent 70%)',
    filter: 'blur(40px)',
    pointerEvents: 'none',
  },
  colorBand2: {
    position: 'absolute',
    bottom: -180, left: -160,
    width: 560, height: 560,
    background: 'radial-gradient(50% 50% at 50% 50%, oklch(32% 0.18 210 / 0.22) 0%, transparent 70%)',
    filter: 'blur(50px)',
    pointerEvents: 'none',
  },
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
  header: { maxWidth: 720, marginBottom: 64, position: 'relative', zIndex: 1 },
  sectionEyebrow: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12,
    letterSpacing: '0.12em',
    color: 'rgba(235,235,245,0.30)',
    textTransform: 'uppercase',
    marginBottom: 16,
  },
  sectionTitle: {
    fontFamily: "'Sora', sans-serif",
    fontSize: 'clamp(2rem, 1rem + 3vw, 3.5rem)',
    fontWeight: 800,
    color: '#fff',
    letterSpacing: '-0.03em',
    lineHeight: 1.1,
    marginBottom: 20,
  },
  sectionSub: {
    fontSize: 16,
    color: 'rgba(235,235,245,0.60)',
    lineHeight: 1.6,
    maxWidth: 560,
  },
  gridWrap: {
    width: 'min(1600px, 100% - 32px)',
    marginLeft: 'auto',
    marginRight: 'auto',
    paddingLeft: 'clamp(16px, 3vw, 32px)',
    paddingRight: 'clamp(16px, 3vw, 32px)',
    position: 'relative',
    zIndex: 1,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(12, 1fr)',
    gridAutoRows: 'minmax(240px, auto)',
    gap: 20,
  },
  card: (hue) => ({
    position: 'relative',
    padding: 28,
    borderRadius: 18,
    background: '#0d0d0f',
    border: '1px solid rgba(84,84,88,0.35)',
    overflow: 'hidden',
    cursor: 'default',
    '--hue': hue,
    display: 'flex',
    flexDirection: 'column',
  }),
  chapterBar: (hue) => ({
    position: 'absolute',
    top: 28, left: 28,
    width: 3, height: 52,
    background: `oklch(62% 0.19 ${hue})`,
    borderRadius: 2,
    boxShadow: `0 0 24px oklch(62% 0.19 ${hue} / 0.55)`,
    transformOrigin: 'top',
  }),
  textColumn: {
    marginLeft: 18,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
  },
  cardEyebrow: {
    paddingTop: 4,
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    color: 'rgba(235,235,245,0.7)',
    letterSpacing: '0.08em',
    marginBottom: 18,
  },
  cardTitle: {
    fontFamily: "'Sora', sans-serif",
    fontSize: 22,
    fontWeight: 700,
    color: '#fff',
    letterSpacing: '-0.02em',
    lineHeight: 1.22,
    marginBottom: 10,
  },
  cardTitleHero: {
    fontSize: 26,
  },
  cardBody: {
    fontSize: 13.5,
    color: 'rgba(235,235,245,0.6)',
    lineHeight: 1.6,
    maxWidth: '42ch',
  },
  cta: (hue) => ({
    display: 'inline-block',
    marginTop: 16,
    padding: '7px 12px',
    borderRadius: 8,
    fontFamily: "'DM Sans', sans-serif",
    fontSize: 12.5,
    fontWeight: 500,
    color: `oklch(78% 0.18 ${hue})`,
    background: `oklch(28% 0.12 ${hue} / 0.2)`,
    border: `1px solid oklch(62% 0.19 ${hue} / 0.35)`,
    textDecoration: 'none',
    transition: 'all 200ms var(--ease-out-expo)',
    cursor: 'pointer',
  }),
  pullQuote: (hue) => ({
    marginTop: 14,
    paddingLeft: 14,
    borderLeft: `2px solid oklch(62% 0.19 ${hue} / 0.55)`,
    fontFamily: "'Sora', sans-serif",
    fontStyle: 'italic',
    fontSize: 15,
    color: 'rgba(235,235,245,0.85)',
    lineHeight: 1.4,
    maxWidth: '32ch',
  }),
}

function Visual({ type, hue, lang, reduced, posters }) {
  if (type === 'poster')   return <PosterVisual      hue={hue} lang={lang} posters={posters} />
  if (type === 'danmaku')  return <DanmakuVisual     hue={hue} />
  if (type === 'multi')    return <TorrentVisual     hue={hue} />
  if (type === 'manual')   return <ManualVisual      hue={hue} />
  if (type === 'resume')   return <ResumeVisual      hue={hue} />
  if (type === 'schedule') return <ScheduleVisual    hue={hue} />
  if (type === 'drop')     return <DropVisual        hue={hue} />
  return null
}

function handleSpotlight(e) {
  const r = e.currentTarget.getBoundingClientRect()
  e.currentTarget.style.setProperty('--mx', `${e.clientX - r.left}px`)
  e.currentTarget.style.setProperty('--my', `${e.clientY - r.top}px`)
}

function BentoCard({ feat, index, lang, reduced, posters }) {
  const { t } = useLang()
  const isHero = feat.size === 'heroL' || feat.size === 'heroR'

  return (
    <motion.article
      className="bento-card"
      data-size={feat.size}
      data-visual={feat.visual}
      style={s.card(feat.hue)}
      onMouseMove={handleSpotlight}
      initial={reduced ? false : { opacity: 0, y: 24, scale: 0.985 }}
      whileInView={reduced ? undefined : { opacity: 1, y: 0, scale: 1 }}
      viewport={{ once: true, margin: '0px 0px -15% 0px' }}
      transition={{
        duration: 0.7,
        delay: ENTRANCE_DELAYS[index] ?? 0,
        ease: [0.16, 1, 0.3, 1],
      }}
    >
      <motion.span
        className="bento-chapter-bar"
        style={s.chapterBar(feat.hue)}
        initial={reduced ? false : { scaleY: 0 }}
        whileInView={reduced ? undefined : { scaleY: 1 }}
        viewport={{ once: true, margin: '0px 0px -15% 0px' }}
        transition={{
          duration: 0.5,
          delay: Math.max(0, (ENTRANCE_DELAYS[index] ?? 0) - 0.06),
          ease: [0.16, 1, 0.3, 1],
        }}
      />
      <div style={s.textColumn}>
        <div style={s.cardEyebrow}>{t(`landing.features.${feat.key}Eyebrow`)}</div>
        <h3 style={{ ...s.cardTitle, ...(isHero ? s.cardTitleHero : null) }}>
          {t(`landing.features.${feat.key}Title`)}
        </h3>
        <p style={s.cardBody}>{t(`landing.features.${feat.key}Body`)}</p>

        {feat.key === 'f1' && (
          <div style={s.pullQuote(feat.hue)}>{t('landing.features.f1Quote')}</div>
        )}
        {feat.key === 'f2' && (
          <div style={s.pullQuote(feat.hue)}>{t('landing.features.f2Quote')}</div>
        )}
      </div>

      <Visual type={feat.visual} hue={feat.hue} lang={lang} reduced={reduced} posters={posters} />

      {feat.hasCta && (
        <div style={s.textColumn}>
          <a href="#" style={s.cta(feat.hue)} className="bento-cta">
            {t(`landing.features.${feat.key}Cta`)}
          </a>
        </div>
      )}
    </motion.article>
  )
}

export default function FeaturesBento({ posters }) {
  const { t, lang } = useLang()
  const reduced = useReducedMotion()

  return (
    <section style={s.section} aria-labelledby="features-title">
      <div style={s.colorBand} aria-hidden />
      <div style={s.colorBand2} aria-hidden />
      <span style={s.sectionNum} aria-hidden>§04</span>
      <style>{`
        .bento-card[data-size="heroL"] { grid-column: span 7; grid-row: span 2; }
        .bento-card[data-size="heroR"] { grid-column: span 5; grid-row: span 2; }
        .bento-card[data-size="md"]    { grid-column: span 4; }
        .bento-card[data-size="lg"]    { grid-column: span 6; }
        @media (max-width: 1180px) {
          .bento-card[data-size="heroL"] { grid-column: span 12; grid-row: auto; }
          .bento-card[data-size="heroR"] { grid-column: span 12; grid-row: auto; }
          .bento-card[data-size="md"]    { grid-column: span 6; }
          .bento-card[data-size="lg"]    { grid-column: span 12; }
        }
        @media (max-width: 720px) {
          .bento-grid { grid-template-columns: 1fr !important; grid-auto-rows: auto !important; }
          .bento-card { grid-column: 1 / -1 !important; grid-row: auto !important; padding: 22px !important; }
        }
        .bento-card {
          --mx: 50%;
          --my: 50%;
          transition: transform 320ms var(--ease-out-expo),
                      border-color 260ms var(--ease-out-expo),
                      box-shadow 320ms var(--ease-out-expo);
        }
        .bento-card::before {
          content: '';
          position: absolute;
          inset: 0;
          pointer-events: none;
          opacity: 0;
          transition: opacity 240ms var(--ease-out-expo);
          background: radial-gradient(420px circle at var(--mx) var(--my), oklch(62% 0.19 var(--hue) / 0.14), transparent 55%);
          z-index: 0;
        }
        .bento-card:hover::before { opacity: 1; }
        .bento-card > * { position: relative; z-index: 1; }
        .bento-card:hover {
          transform: translateY(-5px);
          border-color: oklch(62% 0.19 var(--hue) / 0.45) !important;
          box-shadow: 0 18px 48px -14px oklch(62% 0.19 var(--hue) / 0.28) !important;
        }
        .bento-card:hover .bento-chapter-bar {
          transform: scaleY(1) scaleX(1.5) translateY(-2px);
          height: 68px !important;
        }
        .bento-cta:hover {
          background: oklch(32% 0.14 var(--hue) / 0.3) !important;
          border-color: oklch(62% 0.19 var(--hue) / 0.6) !important;
          transform: translateY(-1px);
        }

        /* ─── Shared keyframes (consumed across cards) ─── */
        @keyframes hudBlink {
          0%, 80%, 100% { opacity: 0.55; }
          85%           { opacity: 1; }
        }
        @keyframes relayDot {
          0%, 6%   { opacity: 0; transform: translateX(-6px); }
          14%      { opacity: 1; transform: translateX(-6px); }
          46%      { opacity: 1; transform: translateX(18px); }
          52%      { opacity: 0; transform: translateX(22px); }
          100%     { opacity: 0; transform: translateX(22px); }
        }
        @keyframes ringDraw {
          from { stroke-dashoffset: var(--ring-c); }
          to   { stroke-dashoffset: var(--ring-offset); }
        }
        @keyframes barGrow {
          from { transform: scaleY(0.2); opacity: 0.4; }
          to   { transform: scaleY(1);   opacity: 1;   }
        }
        @keyframes scanSweep {
          0%       { transform: translateX(0); opacity: 0; }
          10%, 90% { opacity: 1; }
          100%     { transform: translateX(var(--sweep-end, 100%)); opacity: 0; }
        }
        @keyframes f2PlayheadScrub {
          0%          { transform: translateX(0%);   opacity: 0; }
          8%          { opacity: 1; }
          92%         { opacity: 1; }
          100%        { transform: translateX(16%);  opacity: 0; }
        }

        /* ─── f2 density-strip playhead scrub (compositor-friendly) ─── */
        .f2-playhead {
          animation: f2PlayheadScrub 6.8s cubic-bezier(0.33, 1, 0.68, 1) infinite;
          will-change: transform, opacity;
        }

        /* ─── f5 progress ring draw-in on scroll enter (one-shot per ring) ─── */
        .ring-draw {
          animation: ringDraw 1.1s cubic-bezier(0.33, 1, 0.68, 1) forwards;
          animation-delay: var(--ring-delay, 0s);
        }

        /* ─── f7 drop-zone contour scan — 22px bright cursor laps perimeter ─── */
        @keyframes dropContourScan {
          from { stroke-dashoffset: 0; }
          to   { stroke-dashoffset: -10021; }
        }
        .drop-scan rect {
          animation: dropContourScan 3.6s linear infinite;
          opacity: 0.85;
        }

        /* ─── f6 schedule today-lock sweep — enters, locks on Fri (~64%), exits ─── */
        @keyframes scheduleLock {
          0%     { transform: translateX(-4%); opacity: 0; }
          8%     { opacity: 1; }
          48%    { transform: translateX(58%); opacity: 1; }
          68%    { transform: translateX(58%); opacity: 1; }
          100%   { transform: translateX(102%); opacity: 0; }
        }
        .schedule-sweep {
          animation: scheduleLock 2.4s cubic-bezier(0.33, 1, 0.68, 1) forwards;
          animation-delay: 0.2s;
        }

        /* ─── f4 arrow handoff — two dots share relayDot with phase offset ─── */
        .bento-card[data-visual="manual"] .arrow-dot-1 {
          animation: relayDot 6.8s var(--ease-out-expo) infinite;
        }
        .bento-card[data-visual="manual"] .arrow-dot-2 {
          animation: relayDot 6.8s var(--ease-out-expo) infinite;
          animation-delay: 3.4s;
        }
        /* ─── f1 mascot (top-right, bottom flush with tile row bottom = spec block top) ─── */
        .f1-mascot {
          position: absolute;
          right: 0;
          bottom: 0;
          height: 480px;
          width: auto;
          max-width: 340px;
          object-fit: contain;
          object-position: bottom right;
          pointer-events: none;
          z-index: 0;
          filter: drop-shadow(0 18px 42px oklch(20% 0.14 330 / 0.45));
          opacity: 0.95;
          transition: transform 600ms var(--ease-out-expo), opacity 400ms var(--ease-out-expo);
        }
        .bento-card[data-visual="poster"]:hover .f1-mascot {
          transform: translateY(-3px);
          opacity: 1;
        }
        @media (max-width: 1400px) {
          .f1-mascot { height: 420px; max-width: 280px; }
        }
        @media (max-width: 1180px) {
          .f1-mascot { display: none; }
        }

        @media (prefers-reduced-motion: reduce) {
          .bento-card { transition: border-color 200ms linear !important; }
          .bento-card:hover { transform: none !important; }
          .bento-card:hover .bento-chapter-bar { transform: none !important; height: 52px !important; }
          .bento-card[data-visual="manual"] .arrow-dot-1,
          .bento-card[data-visual="manual"] .arrow-dot-2 { animation: none !important; opacity: 0 !important; }
          .f2-playhead { animation: none !important; transform: none !important; opacity: 1 !important; }
          .ring-draw { animation: none !important; }
          .drop-scan rect { animation: none !important; opacity: 0 !important; }
          .schedule-sweep { animation: none !important; opacity: 0 !important; }
          .f1-mascot { transition: none !important; transform: none !important; }
        }
      `}</style>
      <div className="container">
        <header style={s.header}>
          <div style={s.sectionEyebrow}>{t('landing.features.eyebrow')}</div>
          <h2 id="features-title" style={s.sectionTitle}>
            {t('landing.features.title')}
          </h2>
          <p style={s.sectionSub}>{t('landing.features.sub')}</p>
        </header>
      </div>

      <div style={s.gridWrap}>
        <div className="bento-grid" style={s.grid}>
          {featureShape.map((feat, i) => (
            <BentoCard key={feat.key} feat={feat} index={i} lang={lang} reduced={reduced} posters={posters} />
          ))}
        </div>
      </div>
    </section>
  )
}

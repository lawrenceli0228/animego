import { motion as Motion, useReducedMotion } from 'motion/react'
import { useLang } from '../../context/LanguageContext'
import { useCountUp, mono, HUD_VIEWPORT } from './shared/hud-tokens'
import { SectionNum } from './shared/hud'

/* §02 runs on a single hue (210). §04 is the multi-hue showcase; §02 earns
 * its presence through typography + count-up motion, not extra palette. */
const STAT_HUE = 210
const BAR_CONTENT_OFFSET = 12

const statShape = [
  { num: 12480, format: 'comma', key: 's1', tag: 'LIBRARY', span: 2 },
  { num: 3.2,   format: 'M',     key: 's2', tag: 'DANMAKU', span: 1 },
  { num: 48,    format: 'int',   key: 's3', tag: 'SOURCES', span: 1 },
  { num: 200,   format: 'plus',  key: 's4', tag: 'DAILY',   span: 1 },
]

function formatVal(n, format) {
  if (format === 'comma') return n.toLocaleString('en-US')
  if (format === 'M') return n.toFixed(1) + 'M'
  if (format === 'plus') return n + '+'
  return n.toString()
}

const s = {
  section: {
    position: 'relative',
    padding: 'clamp(48px, 4vw, 80px) 0',
    borderBottom: '1px solid rgba(84,84,88,0.30)',
    background: '#000',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(5, 1fr)',
    gap: 'clamp(20px, 2.4vw, 40px)',
  },
  cell: {
    position: 'relative',
    paddingLeft: 20,
    paddingTop: 4,
  },
  cellHero: {
    paddingRight: 24,
    borderRight: '1px solid rgba(84,84,88,0.25)',
  },
  bar: {
    position: 'absolute',
    left: 0,
    top: 4,
    width: 3,
    height: 52,
    background: `oklch(62% 0.17 ${STAT_HUE})`,
    borderRadius: 2,
    boxShadow: `0 0 20px oklch(62% 0.17 ${STAT_HUE} / 0.45)`,
    transformOrigin: 'top',
  },
  readoutTag: {
    ...mono,
    fontSize: 10,
    letterSpacing: '0.14em',
    color: `oklch(72% 0.15 ${STAT_HUE} / 0.85)`,
    textTransform: 'uppercase',
    marginLeft: BAR_CONTENT_OFFSET,
    marginBottom: 10,
  },
  valueRow: {
    marginLeft: BAR_CONTENT_OFFSET,
  },
  value: {
    fontFamily: "'Sora', sans-serif",
    fontSize: 'clamp(2.25rem, 1rem + 3.5vw, 4.25rem)',
    fontWeight: 800,
    letterSpacing: '-0.03em',
    lineHeight: 1,
    color: '#fff',
    fontVariantNumeric: 'tabular-nums',
  },
  valueHero: {
    fontSize: 'clamp(2.75rem, 1rem + 4.5vw, 5.5rem)',
  },
  label: {
    fontFamily: "'DM Sans', sans-serif",
    fontSize: 13,
    color: 'rgba(235,235,245,0.60)',
    marginTop: 10,
    letterSpacing: '0.02em',
  },
  note: {
    ...mono,
    fontSize: 11,
    color: 'rgba(235,235,245,0.30)',
    marginTop: 6,
    letterSpacing: '0.04em',
  },
}

function Stat({ stat, index, label, note }) {
  const reduced = useReducedMotion()
  const staggerDelay = 0.12 + index * 0.08
  const isHero = stat.span === 2
  const [ref, val] = useCountUp(stat.num, {
    duration: 1.6,
    delay: staggerDelay,
    format: (v) => stat.format === 'M' ? v : Math.round(v),
  })
  return (
    <div
      ref={ref}
      style={{
        ...s.cell,
        ...(isHero ? s.cellHero : null),
        gridColumn: `span ${stat.span}`,
      }}
    >
      <Motion.span
        style={s.bar}
        initial={reduced ? false : { scaleY: 0 }}
        whileInView={reduced ? undefined : { scaleY: 1 }}
        viewport={HUD_VIEWPORT}
        transition={{ duration: 0.6, delay: staggerDelay - 0.04, ease: [0.16, 1, 0.3, 1] }}
        aria-hidden
      />
      <div style={s.readoutTag}>{stat.tag}</div>
      <div style={s.valueRow}>
        <div style={{ ...s.value, ...(isHero ? s.valueHero : null) }}>{formatVal(val, stat.format)}</div>
        <div style={s.label}>{label}</div>
        <div style={s.note}>{note}</div>
      </div>
    </div>
  )
}

export default function StatsRow() {
  const { t } = useLang()
  return (
    <section style={s.section} aria-label={t('landing.stats.sectionLabel')}>
      <style>{`
        @media (max-width: 1100px) {
          .stats-grid { grid-template-columns: repeat(2, 1fr) !important; gap: 28px !important; }
          .stats-grid > * { grid-column: span 1 !important; border-right: none !important; padding-right: 0 !important; }
        }
      `}</style>
      <SectionNum n="02" style={{ top: 20 }} />
      <div className="container">
        <div className="stats-grid" style={s.grid}>
          {statShape.map((stat, i) => (
            <Stat
              key={stat.key}
              stat={stat}
              index={i}
              label={t(`landing.stats.${stat.key}Label`)}
              note={t(`landing.stats.${stat.key}Note`)}
            />
          ))}
        </div>
      </div>
    </section>
  )
}

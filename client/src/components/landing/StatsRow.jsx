import { useEffect, useRef, useState } from 'react'
import { useLang } from '../../context/LanguageContext'

const statShape = [
  { num: 12480, format: 'comma', key: 's1', hue: 330 },
  { num: 3.2,   format: 'M',     key: 's2', hue: 210 },
  { num: 48,    format: 'int',   key: 's3', hue: 155 },
  { num: 200,   format: 'plus',  key: 's4', hue: 40  },
]

function formatVal(n, format) {
  if (format === 'comma') return Math.round(n).toLocaleString('en-US')
  if (format === 'M') return n.toFixed(1) + 'M'
  if (format === 'plus') return Math.round(n) + '+'
  return Math.round(n).toString()
}

function useInView(threshold = 0.3) {
  const ref = useRef(null)
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    if (seen || !ref.current) return
    const obs = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { setSeen(true); obs.disconnect() }
    }, { threshold })
    obs.observe(ref.current)
    return () => obs.disconnect()
  }, [seen, threshold])
  return [ref, seen]
}

function useCountUp(target, active, duration = 1800) {
  const [val, setVal] = useState(0)
  useEffect(() => {
    if (!active) return
    const reduced = typeof window !== 'undefined'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) { setVal(target); return }
    const start = performance.now()
    let raf
    const step = (now) => {
      const t = Math.min((now - start) / duration, 1)
      const eased = 1 - Math.pow(1 - t, 3)
      setVal(target * eased)
      if (t < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [active, target, duration])
  return val
}

const s = {
  section: {
    position: 'relative',
    padding: 'clamp(48px, 4vw, 80px) 0',
    borderBottom: '1px solid rgba(84,84,88,0.30)',
    background: '#000',
  },
  sectionNum: {
    position: 'absolute',
    top: 20, right: 32,
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    letterSpacing: '0.14em',
    color: 'rgba(235,235,245,0.30)',
    textTransform: 'uppercase',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: 'clamp(24px, 3vw, 56px)',
  },
  cell: {
    position: 'relative',
    paddingLeft: 20,
  },
  bar: (hue, active) => ({
    position: 'absolute',
    left: 0, top: 4,
    width: 3, height: 44,
    background: `oklch(62% 0.19 ${hue})`,
    borderRadius: 2,
    boxShadow: `0 0 20px oklch(62% 0.19 ${hue} / 0.45)`,
    transformOrigin: 'bottom',
    transform: active ? 'scaleY(1)' : 'scaleY(0)',
    transition: 'transform 800ms var(--ease-out-expo) 120ms',
  }),
  value: {
    fontFamily: "'Sora', sans-serif",
    fontSize: 'clamp(2.25rem, 1rem + 3.5vw, 4.25rem)',
    fontWeight: 800,
    letterSpacing: '-0.03em',
    lineHeight: 1,
    color: '#fff',
    fontVariantNumeric: 'tabular-nums',
  },
  label: {
    fontFamily: "'DM Sans', sans-serif",
    fontSize: 13,
    color: 'rgba(235,235,245,0.60)',
    marginTop: 10,
    letterSpacing: '0.02em',
  },
  note: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    color: 'rgba(235,235,245,0.30)',
    marginTop: 6,
    letterSpacing: '0.04em',
  },
}

function Stat({ stat, active, label, note }) {
  const val = useCountUp(stat.num, active)
  return (
    <div style={s.cell}>
      <span style={s.bar(stat.hue, active)} aria-hidden />
      <div style={s.value}>{formatVal(val, stat.format)}</div>
      <div style={s.label}>{label}</div>
      <div style={s.note}>{note}</div>
    </div>
  )
}

export default function StatsRow() {
  const [ref, inView] = useInView(0.25)
  const { t } = useLang()
  return (
    <section ref={ref} style={s.section} aria-label={t('landing.docTitle')}>
      <style>{`
        @media (max-width: 880px) {
          .stats-grid { grid-template-columns: repeat(2, 1fr) !important; gap: 32px !important; }
        }
      `}</style>
      <span style={s.sectionNum} aria-hidden>§02</span>
      <div className="container">
        <div className="stats-grid" style={s.grid}>
          {statShape.map((stat) => (
            <Stat
              key={stat.key}
              stat={stat}
              active={inView}
              label={t(`landing.stats.${stat.key}Label`)}
              note={t(`landing.stats.${stat.key}Note`)}
            />
          ))}
        </div>
      </div>
    </section>
  )
}

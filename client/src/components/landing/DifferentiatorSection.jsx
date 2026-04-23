/**
 * Three bold manifesto statements + explanations.
 * Explicitly NOT a ✓/✗ comparison table (too SaaS).
 */

import { useState } from 'react'
import { useLang } from '../../context/LanguageContext'

const itemKeys = [
  { num: '01', key: 'c1' },
  { num: '02', key: 'c2' },
  { num: '03', key: 'c3' },
]

const s = {
  section: {
    position: 'relative',
    padding: 'clamp(80px, 7vw, 120px) 0',
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
  grid: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 0.8fr) minmax(0, 1fr)',
    gap: 'clamp(32px, 5vw, 96px)',
    alignItems: 'start',
  },
  stickyLeft: {
    position: 'sticky',
    top: 96,
  },
  eyebrow: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12,
    letterSpacing: '0.12em',
    color: 'rgba(235,235,245,0.30)',
    textTransform: 'uppercase',
    marginBottom: 16,
  },
  title: {
    fontFamily: "'Sora', sans-serif",
    fontSize: 'clamp(2rem, 1rem + 3vw, 3.25rem)',
    fontWeight: 800,
    color: '#fff',
    letterSpacing: '-0.03em',
    lineHeight: 1.1,
  },
  subtle: {
    marginTop: 20,
    fontSize: 15,
    color: 'rgba(235,235,245,0.60)',
    lineHeight: 1.6,
    maxWidth: 420,
  },
  list: { display: 'flex', flexDirection: 'column' },
  row: {
    display: 'grid',
    gridTemplateColumns: '64px 1fr',
    gap: 24,
    padding: '32px 0',
    borderBottom: '1px solid rgba(84,84,88,0.30)',
  },
  rowLast: {
    borderBottom: 'none',
  },
  num: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 13,
    color: 'rgba(235,235,245,0.30)',
    letterSpacing: '0.08em',
    paddingTop: 6,
  },
  claim: {
    // Serif italic breaks the page's Sora-only rhythm — magazine pull-quote feel.
    fontFamily: '"EB Garamond", Georgia, "Times New Roman", serif',
    fontStyle: 'italic',
    fontSize: 'clamp(1.625rem, 1rem + 1.2vw, 2.25rem)',
    fontWeight: 500,
    color: '#fff',
    letterSpacing: '-0.01em',
    lineHeight: 1.2,
    marginBottom: 14,
  },
  body: {
    fontSize: 15,
    color: 'rgba(235,235,245,0.60)',
    lineHeight: 1.7,
    maxWidth: '58ch',
  },
  demoRow: {
    marginTop: 64,
    paddingTop: 32,
    borderTop: '1px solid rgba(84,84,88,0.30)',
  },
  demoHeader: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 16,
    marginBottom: 24,
    flexWrap: 'wrap',
  },
  demoChip: {
    display: 'inline-flex', alignItems: 'center', gap: 8,
    padding: '5px 12px',
    borderRadius: 9999,
    background: 'oklch(62% 0.19 40 / 0.14)',
    border: '1px solid oklch(62% 0.19 40 / 0.35)',
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    letterSpacing: '0.08em',
    color: 'oklch(82% 0.15 40)',
    textTransform: 'uppercase',
  },
  demoHeadline: {
    fontFamily: "'Sora', sans-serif",
    fontSize: 'clamp(1.25rem, 1rem + 0.6vw, 1.625rem)',
    fontWeight: 700,
    color: '#fff',
    letterSpacing: '-0.02em',
    lineHeight: 1.25,
    margin: 0,
  },
  demo: {
    padding: 24,
    borderRadius: 14,
    background: 'rgba(255,255,255,0.02)',
    border: '1px solid rgba(84,84,88,0.35)',
  },
  demoEyebrow: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10,
    letterSpacing: '0.14em',
    color: 'rgba(235,235,245,0.30)',
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  demoTitle: {
    fontFamily: "'Sora', sans-serif",
    fontSize: 15,
    fontWeight: 600,
    color: '#fff',
    marginBottom: 4,
  },
  demoHint: {
    fontFamily: "'DM Sans', sans-serif",
    fontSize: 13,
    color: 'rgba(235,235,245,0.60)',
    marginBottom: 16,
  },
  epGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(12, 1fr)',
    gap: 6,
  },
  ep: (active) => ({
    aspectRatio: '1',
    borderRadius: 6,
    background: active ? 'oklch(62% 0.19 40)' : 'rgba(255,255,255,0.04)',
    border: active ? '1px solid oklch(78% 0.19 40)' : '1px solid rgba(255,255,255,0.06)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10,
    color: active ? '#000' : 'rgba(235,235,245,0.60)',
    fontWeight: active ? 700 : 500,
    boxShadow: active ? '0 0 16px oklch(62% 0.19 40 / 0.55)' : 'none',
    transition: 'all 180ms var(--ease-out-expo)',
    cursor: 'pointer',
  }),
  demoCaption: {
    marginTop: 14,
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    color: 'rgba(235,235,245,0.60)',
    letterSpacing: '0.04em',
  },
}

function MiniPicker() {
  const { t } = useLang()
  const [picked, setPicked] = useState(5)
  const epLabelPrefix = t('landing.differentiator.epLabelPrefix')
  const epLabelSuffix = t('landing.differentiator.epLabelSuffix')
  return (
    <div style={s.demoRow}>
      <div style={s.demoHeader}>
        <span style={s.demoChip}>{t('landing.differentiator.demoChip')}</span>
        <h3 style={s.demoHeadline}>{t('landing.differentiator.demoHeadline')}</h3>
      </div>
      <div style={s.demo}>
        <div style={s.demoEyebrow}>{t('landing.differentiator.demoEyebrow')}</div>
        <div style={s.demoTitle}>{t('landing.differentiator.demoTitle')}</div>
        <div style={s.demoHint}>{t('landing.differentiator.demoHint')}</div>
        <div style={s.epGrid}>
          {Array.from({ length: 12 }).map((_, i) => (
            <button
              key={i}
              type="button"
              style={s.ep(picked === i)}
              onClick={() => setPicked(i)}
              aria-label={`${epLabelPrefix}${i + 1}${epLabelSuffix}`}
              aria-pressed={picked === i}
            >
              {i + 1}
            </button>
          ))}
        </div>
        <div style={s.demoCaption}>
          {t('landing.differentiator.demoCaptionPrefix')}{String(picked + 1).padStart(2, '0')}{t('landing.differentiator.demoCaptionSuffix')}
        </div>
      </div>
    </div>
  )
}

export default function DifferentiatorSection() {
  const { t } = useLang()
  return (
    <section style={s.section} aria-labelledby="diff-title">
      <style>{`
        @media (max-width: 880px) {
          .diff-grid { grid-template-columns: 1fr !important; gap: 40px !important; }
          .diff-sticky { position: static !important; }
        }
      `}</style>
      <span style={s.sectionNum} aria-hidden>§06</span>
      <div className="container">
        <div className="diff-grid" style={s.grid}>
          <div className="diff-sticky" style={s.stickyLeft}>
            <div style={s.eyebrow}>{t('landing.differentiator.eyebrow')}</div>
            <h2 id="diff-title" style={s.title}>
              {t('landing.differentiator.title')}
            </h2>
            <p style={s.subtle}>
              {t('landing.differentiator.sub')}
            </p>
          </div>
          <div style={s.list}>
            {itemKeys.map((it, i) => (
              <div
                key={it.num}
                style={{ ...s.row, ...(i === itemKeys.length - 1 ? s.rowLast : null) }}
              >
                <div style={s.num}>{it.num}</div>
                <div>
                  <h3 style={s.claim}>{t(`landing.differentiator.${it.key}Claim`)}</h3>
                  <p style={s.body}>{t(`landing.differentiator.${it.key}Body`)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <MiniPicker />
      </div>
    </section>
  )
}

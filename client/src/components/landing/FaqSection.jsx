/**
 * Native <details>/<summary> for zero-JS accessibility.
 * No rotating chevrons, no animated plus-signs — just a hairline reveal.
 */

import { useLang } from '../../context/LanguageContext'

const faqKeys = [
  { key: 'q1', hue: 330 },
  { key: 'q2', hue: 40  },
  { key: 'q3', hue: 210 },
  { key: 'q4', hue: 155 },
  { key: 'q5', hue: 330 },
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
  header: {
    maxWidth: 720,
    marginBottom: 48,
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
    fontSize: 'clamp(2rem, 1rem + 3vw, 3rem)',
    fontWeight: 800,
    color: '#fff',
    letterSpacing: '-0.03em',
    lineHeight: 1.1,
  },
  list: {
    maxWidth: 760,
    borderTop: '1px solid rgba(84,84,88,0.30)',
  },
  item: (hue) => ({
    position: 'relative',
    borderBottom: '1px solid rgba(84,84,88,0.30)',
    '--faq-hue': hue,
  }),
  hueBar: (hue) => ({
    position: 'absolute',
    left: -20, top: 22,
    width: 3, height: 28,
    background: `oklch(62% 0.19 ${hue})`,
    borderRadius: 2,
    opacity: 0,
    transform: 'translateX(8px)',
    transition: 'opacity 200ms var(--ease-out-expo), transform 200ms var(--ease-out-expo)',
    boxShadow: `0 0 16px oklch(62% 0.19 ${hue} / 0.5)`,
    pointerEvents: 'none',
  }),
  summary: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '24px 4px',
    cursor: 'pointer',
    listStyle: 'none',
    fontFamily: "'Sora', sans-serif",
    fontSize: 18,
    fontWeight: 600,
    color: '#fff',
    letterSpacing: '-0.01em',
    transition: 'color 150ms var(--ease-out-expo)',
  },
  marker: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 16,
    color: 'rgba(235,235,245,0.30)',
    marginLeft: 16,
    transition: 'transform 200ms var(--ease-out-expo), color 200ms',
  },
  body: {
    padding: '0 4px 24px',
    maxWidth: '65ch',
    fontSize: 15,
    color: 'rgba(235,235,245,0.60)',
    lineHeight: 1.7,
  },
}

export default function FaqSection() {
  const { t } = useLang()
  return (
    <section style={s.section} aria-labelledby="faq-title">
      <style>{`
        details > summary { list-style: none; }
        details > summary::-webkit-details-marker { display: none; }
        details[open] .faq-marker { transform: rotate(45deg); color: #fff; }
        details[open] .faq-huebar { opacity: 1 !important; transform: translateX(0) !important; }
        details:hover > summary { color: #fff; }
        details > summary:focus-visible { outline: 2px solid oklch(62% 0.19 210); outline-offset: 4px; border-radius: 4px; }
      `}</style>
      <span style={s.sectionNum} aria-hidden>§08</span>
      <div className="container">
        <header style={s.header}>
          <div style={s.eyebrow}>{t('landing.faq.eyebrow')}</div>
          <h2 id="faq-title" style={s.title}>{t('landing.faq.title')}</h2>
        </header>

        <div style={s.list}>
          {faqKeys.map((f) => {
            const q = t(`landing.faq.${f.key}`)
            const a = t(`landing.faq.a${f.key.slice(1)}`)
            return (
              <details key={f.key} style={s.item(f.hue)}>
                <span className="faq-huebar" style={s.hueBar(f.hue)} aria-hidden />
                <summary style={s.summary}>
                  <span>{q}</span>
                  <span className="faq-marker" style={s.marker}>+</span>
                </summary>
                <p style={s.body}>{a}</p>
              </details>
            )
          })}
        </div>
      </div>
    </section>
  )
}

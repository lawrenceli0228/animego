/**
 * §08 · FAQ — native <details>/<summary> for zero-JS accessibility.
 * HUD family: single hue=70 (chartreuse / amber-green), shared primitives,
 * [OPEN]/[CLOSE] mono marker replaces the rotating `+` glyph.
 */

import { useLang } from '../../context/LanguageContext'
import { mono } from './shared/hud-tokens'
import { SectionNum, SectionHeader, ChapterBar } from './shared/hud'

const SECTION_HUE = 70

const faqKeys = ['q1', 'q2', 'q3', 'q4', 'q5']

const s = {
  section: {
    position: 'relative',
    padding: 'clamp(80px, 7vw, 120px) 0',
    background: '#000',
    borderTop: '1px solid rgba(84,84,88,0.30)',
  },
  headerWrap: {
    position: 'relative',
    paddingLeft: 20,
    marginBottom: 48,
    maxWidth: 760,
  },
  headerOverride: {
    marginBottom: 0,
  },
  list: {
    maxWidth: 760,
    borderTop: '1px solid rgba(84,84,88,0.30)',
  },
  item: {
    position: 'relative',
    borderBottom: '1px solid rgba(84,84,88,0.30)',
  },
  hueBar: {
    position: 'absolute',
    left: -20, top: 22,
    width: 3, height: 28,
    background: `oklch(82% 0.16 ${SECTION_HUE})`,
    borderRadius: 2,
    opacity: 0,
    transform: 'translateX(8px)',
    transition: 'opacity 200ms var(--ease-out-expo), transform 200ms var(--ease-out-expo)',
    boxShadow: `0 0 16px oklch(82% 0.16 ${SECTION_HUE} / 0.5)`,
    pointerEvents: 'none',
  },
  summary: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '24px 4px',
    gap: 16,
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
    ...mono,
    fontSize: 11,
    letterSpacing: '0.14em',
    color: `oklch(78% 0.14 ${SECTION_HUE} / 0.75)`,
    whiteSpace: 'nowrap',
    transition: 'color 200ms var(--ease-out-expo)',
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
        details[open] .faq-huebar { opacity: 1 !important; transform: translateX(0) !important; }
        details[open] .faq-marker-closed { display: none; }
        details:not([open]) .faq-marker-open { display: none; }
        details[open] .faq-marker { color: oklch(88% 0.13 ${SECTION_HUE}); }
        details:hover > summary { color: #fff; }
        details > summary:focus-visible {
          outline: 2px solid oklch(82% 0.16 ${SECTION_HUE});
          outline-offset: 4px;
          border-radius: 4px;
        }
      `}</style>
      <SectionNum n="08" />
      <div className="container">
        <div style={s.headerWrap}>
          <ChapterBar hue={SECTION_HUE} style={{ top: 0, left: 0 }} />
          <SectionHeader
            eyebrow={t('landing.faq.eyebrow')}
            title={t('landing.faq.title')}
            titleId="faq-title"
            style={s.headerOverride}
          />
        </div>

        <div style={s.list}>
          {faqKeys.map((key) => {
            const q = t(`landing.faq.${key}`)
            const a = t(`landing.faq.a${key.slice(1)}`)
            return (
              <details key={key} style={s.item}>
                <summary style={s.summary}>
                  <span className="faq-huebar" style={s.hueBar} aria-hidden />
                  <span>{q}</span>
                  <span className="faq-marker" style={s.marker} aria-hidden="true">
                    <span className="faq-marker-closed">[OPEN]</span>
                    <span className="faq-marker-open">[CLOSE]</span>
                  </span>
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

/**
 * Product-demo section: shows three "detail pages" as tinted frames,
 * each soaked in its own OKLCH poster accent extracted from the real cover.
 * Background is a color band that interpolates between the three hues —
 * making "color IS identity" visible at a glance.
 */

import { useLang } from '../../context/LanguageContext'
import { pickTitle } from '../../utils/formatters'

const FALLBACK_FRAMES = [
  { hue: 330, title: '—', format: 'TV', episodes: '—', coverImageUrl: null },
  { hue: 40,  title: '—', format: 'TV', episodes: '—', coverImageUrl: null },
  { hue: 155, title: '—', format: 'TV', episodes: '—', coverImageUrl: null },
]
const FRAME_HUE_FALLBACK = [330, 40, 155]

const s = {
  section: {
    position: 'relative',
    padding: 'clamp(80px, 7vw, 120px) 0',
    overflow: 'hidden',
    background: '#000',
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
  colorBand: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    height: '60%',
    background: `linear-gradient(90deg,
      oklch(32% 0.16 355 / 0.35) 0%,
      oklch(32% 0.16 200 / 0.35) 50%,
      oklch(32% 0.16 150 / 0.35) 100%)`,
    filter: 'blur(120px)',
    pointerEvents: 'none',
  },
  inner: { position: 'relative', zIndex: 1 },
  header: { maxWidth: 720, marginBottom: 72 },
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
    fontSize: 'clamp(2rem, 1rem + 3vw, 3.5rem)',
    fontWeight: 800,
    color: '#fff',
    letterSpacing: '-0.03em',
    lineHeight: 1.1,
    marginBottom: 20,
  },
  sub: {
    fontSize: 16,
    color: 'rgba(235,235,245,0.60)',
    lineHeight: 1.6,
    maxWidth: 560,
  },
  row: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 24,
    alignItems: 'start',
  },
  frameCard: (hue, offsetY) => ({
    position: 'relative',
    aspectRatio: '3/4',
    borderRadius: 18,
    overflow: 'hidden',
    background: `
      linear-gradient(180deg, oklch(10% 0.03 ${hue}) 0%, oklch(6% 0.01 ${hue}) 100%),
      radial-gradient(60% 40% at 50% 20%, oklch(45% 0.18 ${hue} / 0.45) 0%, transparent 60%)
    `,
    border: `1px solid oklch(62% 0.19 ${hue} / 0.55)`,
    boxShadow: `
      0 24px 60px -12px oklch(62% 0.19 ${hue} / 0.55),
      0 0 40px -8px oklch(62% 0.19 ${hue} / 0.35)
    `,
    transform: `translateY(${offsetY}px)`,
    transition: 'transform 300ms var(--ease-out-expo)',
    '--offset-y': `${offsetY}px`,
  }),
  // Fake detail-page UI inside the frame
  coverWrap: {
    position: 'relative',
    margin: '22px 22px 16px',
  },
  cover: (hue) => ({
    position: 'relative',
    aspectRatio: '3/4',
    borderRadius: 10,
    overflow: 'hidden',
    background: `oklch(10% 0.04 ${hue})`,
    boxShadow: `0 8px 28px -6px oklch(58% 0.2 ${hue} / 0.45)`,
    border: '1px solid rgba(255,255,255,0.06)',
  }),
  coverImg: {
    position: 'absolute', inset: 0,
    width: '100%', height: '100%',
    objectFit: 'cover',
    display: 'block',
  },
  coverTint: (hue) => ({
    position: 'absolute', inset: 0,
    background: `linear-gradient(180deg, transparent 40%, oklch(18% 0.08 ${hue} / 0.45) 100%)`,
    pointerEvents: 'none',
  }),
  samplePoint: (xPct, yPct, hue) => ({
    position: 'absolute',
    left: `${xPct}%`, top: `${yPct}%`,
    width: 14, height: 14,
    marginLeft: -7, marginTop: -7,
    borderRadius: '50%',
    background: `oklch(62% 0.19 ${hue})`,
    boxShadow: `0 0 0 2px rgba(0,0,0,0.5), 0 0 12px oklch(62% 0.19 ${hue} / 0.9)`,
    opacity: 0,
    transform: 'scale(0.4)',
    transition: 'opacity 200ms var(--ease-out-expo), transform 200ms var(--ease-out-expo)',
    pointerEvents: 'none',
  }),
  samplePulse: (xPct, yPct, hue) => ({
    position: 'absolute',
    left: `${xPct}%`, top: `${yPct}%`,
    width: 14, height: 14,
    marginLeft: -7, marginTop: -7,
    borderRadius: '50%',
    border: `1.5px solid oklch(62% 0.19 ${hue})`,
    opacity: 0,
    pointerEvents: 'none',
  }),
  oklchReadout: (hue) => ({
    position: 'absolute',
    left: 12, right: 12, bottom: 12,
    padding: '8px 12px',
    borderRadius: 6,
    background: 'rgba(0,0,0,0.72)',
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    border: `1px solid oklch(62% 0.19 ${hue} / 0.45)`,
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10,
    letterSpacing: '0.06em',
    color: '#fff',
    display: 'flex', alignItems: 'center', gap: 8,
    opacity: 0,
    transform: 'translateY(6px)',
    transition: 'opacity 220ms var(--ease-out-expo) 80ms, transform 220ms var(--ease-out-expo) 80ms',
    pointerEvents: 'none',
  }),
  oklchSwatch: (hue) => ({
    width: 10, height: 10, borderRadius: 3,
    background: `oklch(62% 0.19 ${hue})`,
    boxShadow: `0 0 6px oklch(62% 0.19 ${hue} / 0.9)`,
    flexShrink: 0,
  }),
  meta: { padding: '0 22px 20px' },
  metaLabel: (hue) => ({
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10,
    letterSpacing: '0.1em',
    color: `oklch(78% 0.15 ${hue})`,
    marginBottom: 6,
  }),
  metaTitle: {
    fontFamily: "'Sora', sans-serif",
    fontSize: 17,
    fontWeight: 700,
    color: '#fff',
    letterSpacing: '-0.01em',
    marginBottom: 8,
  },
  bars: { display: 'flex', flexDirection: 'column', gap: 5 },
  bar: (w, hue, active) => ({
    height: 4,
    width: `${w}%`,
    borderRadius: 2,
    background: active ? `oklch(62% 0.19 ${hue})` : 'rgba(255,255,255,0.08)',
  }),
  caption: {
    marginTop: 40,
    textAlign: 'center',
    fontFamily: "'DM Sans', sans-serif",
    fontSize: 14,
    color: 'rgba(235,235,245,0.60)',
    fontStyle: 'italic',
  },
}

export default function PosterIdentityShowcase({ posters = [] }) {
  const { lang, t } = useLang()
  const airing = t('landing.identity.airing')
  const epSuffix = t('landing.identity.episodesSuffix')
  const frames = posters.length >= 3
    ? posters.slice(0, 3).map((p, i) => ({
        hue: p.posterAccent ?? FRAME_HUE_FALLBACK[i] ?? 330,
        title: pickTitle(p, lang),
        format: p.format || 'TV',
        episodes: p.episodes ? `${p.episodes}${epSuffix}` : airing,
        coverImageUrl: p.coverImageUrl,
      }))
    : FALLBACK_FRAMES
  return (
    <section style={s.section} aria-labelledby="identity-title">
      <style>{`
        @media (max-width: 880px) {
          .showcase-row { grid-template-columns: 1fr !important; }
          .showcase-frame { transform: none !important; }
        }
        .showcase-frame:hover {
          transform: translateY(calc(var(--offset-y, 0px) - 6px)) !important;
        }
        @keyframes samplePulseAnim {
          0%   { transform: scale(0.6); opacity: 0.9; }
          100% { transform: scale(2.4); opacity: 0; }
        }
        .showcase-frame:hover .sample-point {
          opacity: 1 !important;
          transform: scale(1) !important;
        }
        .showcase-frame:hover .sample-pulse {
          animation: samplePulseAnim 1.6s var(--ease-out-expo) infinite;
        }
        .showcase-frame .sample-pulse:nth-child(2) { animation-delay: 0s; }
        .showcase-frame .sample-pulse:nth-child(3) { animation-delay: 0.4s; }
        .showcase-frame .sample-pulse:nth-child(4) { animation-delay: 0.8s; }
        .showcase-frame:hover .oklch-readout {
          opacity: 1 !important;
          transform: translateY(0) !important;
        }
        @media (prefers-reduced-motion: reduce) {
          .sample-pulse { animation: none !important; }
        }
      `}</style>
      <span style={s.sectionNum} aria-hidden>§05</span>
      <div style={s.colorBand} aria-hidden />
      <div className="container" style={s.inner}>
        <header style={s.header}>
          <div style={s.eyebrow}>{t('landing.identity.eyebrow')}</div>
          <h2 id="identity-title" style={s.title}>
            {t('landing.identity.title')}
          </h2>
          <p style={s.sub}>
            {t('landing.identity.sub')}
          </p>
        </header>

        <div className="showcase-row" style={s.row}>
          {frames.map((f, i) => (
            <div key={i} className="showcase-frame" style={s.frameCard(f.hue, i === 1 ? -24 : 0)}>
              <div style={s.coverWrap}>
                <div style={s.cover(f.hue)}>
                  {f.coverImageUrl ? (
                    <img src={f.coverImageUrl} alt={f.title} style={s.coverImg} loading="lazy" />
                  ) : null}
                  <div style={s.coverTint(f.hue)} aria-hidden />
                </div>
                <span className="sample-pulse" style={s.samplePulse(28, 28, f.hue)} aria-hidden />
                <span className="sample-pulse" style={s.samplePulse(62, 44, f.hue)} aria-hidden />
                <span className="sample-pulse" style={s.samplePulse(42, 72, f.hue)} aria-hidden />
                <span className="sample-point" style={s.samplePoint(28, 28, f.hue)} aria-hidden />
                <span className="sample-point" style={s.samplePoint(62, 44, f.hue)} aria-hidden />
                <span className="sample-point" style={s.samplePoint(42, 72, f.hue)} aria-hidden />
                <div className="oklch-readout" style={s.oklchReadout(f.hue)} aria-hidden>
                  <span style={s.oklchSwatch(f.hue)} />
                  <span>oklch(62% 0.19 {f.hue})</span>
                </div>
              </div>
              <div style={s.meta}>
                <div style={s.metaLabel(f.hue)}>{f.format} · {f.episodes}</div>
                <div style={s.metaTitle}>{f.title}</div>
                <div style={s.bars}>
                  <span style={s.bar(68, f.hue, true)} />
                  <span style={s.bar(48, f.hue, false)} />
                  <span style={s.bar(32, f.hue, false)} />
                </div>
              </div>
            </div>
          ))}
        </div>

        <p style={s.caption}>
          {t('landing.identity.caption')}
        </p>
      </div>
    </section>
  )
}

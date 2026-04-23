/**
 * Product-demo section: shows three "detail pages" as tinted frames,
 * each soaked in its own OKLCH poster accent. Background is a color band
 * that interpolates between the three hues — making "color IS identity"
 * visible at a glance.
 */

const frames = [
  { hue: 355, title: '鬼灭之刃', season: 'S3', episode: '第 11 话' },
  { hue: 200, title: '鏈鋸人', season: 'S1', episode: '第 08 话' },
  { hue: 150, title: 'Spy×Family', season: 'S2', episode: '第 14 话' },
]

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
    border: `1px solid oklch(62% 0.19 ${hue} / 0.35)`,
    boxShadow: `0 24px 60px -12px oklch(62% 0.19 ${hue} / 0.30)`,
    transform: `translateY(${offsetY}px)`,
    transition: 'transform 300ms var(--ease-out-expo)',
    '--offset-y': `${offsetY}px`,
  }),
  // Fake detail-page UI inside the frame
  cover: (hue) => ({
    margin: '22px 22px 16px',
    aspectRatio: '3/4',
    borderRadius: 10,
    background: `radial-gradient(80% 60% at 50% 30%, oklch(58% 0.2 ${hue}) 0%, oklch(25% 0.11 ${hue}) 55%, oklch(10% 0.04 ${hue}) 100%)`,
    boxShadow: `0 8px 28px -6px oklch(58% 0.2 ${hue} / 0.45)`,
    border: '1px solid rgba(255,255,255,0.06)',
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

export default function PosterIdentityShowcase() {
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
      `}</style>
      <span style={s.sectionNum} aria-hidden>§04</span>
      <div style={s.colorBand} aria-hidden />
      <div className="container" style={s.inner}>
        <header style={s.header}>
          <div style={s.eyebrow}>Case / 产品演示</div>
          <h2 id="identity-title" style={s.title}>
            颜色会告诉你,这是哪一部。
          </h2>
          <p style={s.sub}>
            三部番,三种详情页色身份。主色从封面 OKLCH 归一化提取 ——
            不是染色,是让这部番在 UI 里也保持自己的气质。
          </p>
        </header>

        <div className="showcase-row" style={s.row}>
          {frames.map((f, i) => (
            <div key={i} className="showcase-frame" style={s.frameCard(f.hue, i === 1 ? -24 : 0)}>
              <div style={s.cover(f.hue)} />
              <div style={s.meta}>
                <div style={s.metaLabel(f.hue)}>{f.season} · {f.episode}</div>
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
          同一套 UI,三种身份 —— 这件事别的动漫站没做。
        </p>
      </div>
    </section>
  )
}

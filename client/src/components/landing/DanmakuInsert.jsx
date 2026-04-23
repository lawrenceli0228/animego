/**
 * Magazine-style insert page: a 16:9 frozen frame with danmaku pinned in place.
 * Uses a pure-CSS composition (no external images) and a podcast-notes caption.
 */

const danmaku = [
  { t: '这镜头绝了',       x: 10, y: 18, size: 15, op: 1    },
  { t: '芙莉莲会心一击',   x: 56, y: 32, size: 14, op: 0.85 },
  { t: '每周日就等这个',   x: 22, y: 56, size: 13, op: 0.7  },
  { t: 'op 泪目',          x: 62, y: 72, size: 13, op: 0.55 },
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
  frame: {
    position: 'relative',
    aspectRatio: '16/9',
    borderRadius: 18,
    overflow: 'hidden',
    background: `
      radial-gradient(60% 50% at 50% 40%, #1a1a2e 0%, #0a0a14 60%, #000 100%),
      linear-gradient(180deg, transparent 0%, rgba(0,0,0,0.55) 100%)
    `,
    border: '1px solid rgba(255,255,255,0.06)',
    boxShadow: '0 32px 80px rgba(0,0,0,0.55)',
  },
  // Fake scenery silhouette — three layered gradient "hills"
  hill: (z, hue, opacity) => ({
    position: 'absolute',
    left: 0, right: 0,
    bottom: 0,
    height: `${30 + z * 12}%`,
    background: `linear-gradient(to top, oklch(14% 0.04 ${hue}) 0%, oklch(22% 0.08 ${hue}) 60%, transparent 100%)`,
    opacity,
    clipPath: z === 0
      ? 'polygon(0% 60%, 15% 40%, 35% 55%, 55% 30%, 75% 50%, 100% 35%, 100% 100%, 0% 100%)'
      : z === 1
      ? 'polygon(0% 70%, 20% 50%, 40% 65%, 70% 45%, 100% 60%, 100% 100%, 0% 100%)'
      : 'polygon(0% 80%, 50% 65%, 100% 75%, 100% 100%, 0% 100%)',
  }),
  // A faint silhouette of a character/figure
  figure: {
    position: 'absolute',
    left: '50%',
    bottom: '8%',
    transform: 'translateX(-50%)',
    width: '18%',
    height: '55%',
    background: 'radial-gradient(ellipse 50% 35% at 50% 20%, rgba(255,255,255,0.08) 0%, transparent 70%), linear-gradient(to top, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0.15) 100%)',
    clipPath: 'polygon(40% 0%, 60% 0%, 65% 25%, 70% 55%, 80% 75%, 80% 100%, 20% 100%, 20% 75%, 30% 55%, 35% 25%)',
    filter: 'blur(0.3px)',
  },
  danmaku: (x, y, size, opacity) => ({
    position: 'absolute',
    left: `${x}%`, top: `${y}%`,
    fontFamily: "'DM Sans', sans-serif",
    fontSize: size,
    color: '#fff',
    opacity,
    textShadow: '1px 1px 3px rgba(0,0,0,0.92)',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
  }),
  corner: {
    position: 'absolute',
    top: 18, left: 20, right: 20,
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10, letterSpacing: '0.12em',
    color: 'rgba(255,255,255,0.55)',
    textTransform: 'uppercase',
    pointerEvents: 'none',
  },
  bottomBar: {
    position: 'absolute',
    left: 20, right: 20, bottom: 18,
    height: 3, borderRadius: 2,
    background: 'rgba(255,255,255,0.12)',
    overflow: 'hidden',
  },
  bottomBarFill: {
    width: '38%', height: '100%',
    background: 'oklch(62% 0.19 210)',
  },
  caption: {
    marginTop: 32,
    display: 'grid',
    gridTemplateColumns: 'auto 1fr',
    gap: 16,
    alignItems: 'baseline',
  },
  capLabel: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    color: 'rgba(235,235,245,0.30)',
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    whiteSpace: 'nowrap',
  },
  capText: {
    fontFamily: "'DM Sans', sans-serif",
    fontSize: 15,
    color: 'rgba(235,235,245,0.60)',
    lineHeight: 1.6,
    fontStyle: 'italic',
  },
}

export default function DanmakuInsert() {
  return (
    <section style={s.section} aria-labelledby="danmaku-title">
      <span style={s.sectionNum} aria-hidden>§06</span>
      <div className="container">
        <h2 id="danmaku-title" style={{
          fontFamily: "'Sora', sans-serif",
          fontSize: 'clamp(2rem, 1rem + 3vw, 3.25rem)',
          fontWeight: 800, color: '#fff',
          letterSpacing: '-0.03em', lineHeight: 1.1,
          maxWidth: 560, marginBottom: 48,
        }}>
          一帧里,三千条人声。
        </h2>

        <div style={s.frame} aria-hidden="true">
          <div style={s.hill(0, 268, 0.6)} aria-hidden />
          <div style={s.hill(1, 220, 0.75)} aria-hidden />
          <div style={s.hill(2, 200, 0.9)} aria-hidden />
          <div style={s.figure} aria-hidden />

          <div style={s.corner}>
            <span>ep.18 · 21:43</span>
            <span>● LIVE · 3,812 人同时观看</span>
          </div>

          {danmaku.map((d, i) => (
            <span key={i} style={s.danmaku(d.x, d.y, d.size, d.op)}>{d.t}</span>
          ))}

          <div style={s.bottomBar} aria-hidden>
            <div style={s.bottomBarFill} />
          </div>
        </div>

        <div style={s.caption}>
          <div style={s.capLabel}>Show notes</div>
          <p style={s.capText}>
            2026-04-21 周日晚 22:14,《葬送的芙莉莲》第 18 话 ——
            3,812 条弹幕在同一帧里飘过。你不是一个人在追。
          </p>
        </div>
      </div>
    </section>
  )
}

/**
 * Magazine-style insert page: a 16:9 frozen frame with danmaku pinned in place.
 * Uses a real trending poster (via `poster` prop) as the backdrop — blurred and
 * scrim-darkened so the pinned danmaku stays legible.
 */

import { useLang } from '../../context/LanguageContext'
import { pickTitle } from '../../utils/formatters'

const FALLBACK_HUE = 210

const laneTop = [
  '这镜头绝了', '芙莉莲会心一击', 'op 泪目', '这作画给跪了',
  '周日晚上刚需', '这分镜不得了', '眼泪止不住', '同步率 101%',
]

// Pinned "frozen" danmaku — evoking "一帧里,三千条人声" without
// turning the panel into a scrolling LED ticker.
const pinned = [
  { t: '每周日就等这个', x: 14, y: 42, size: 13, op: 0.95 },
  { t: '这分镜不得不服', x: 52, y: 58, size: 14, op: 1 },
  { t: 'op 又来了泪目',  x: 28, y: 74, size: 12, op: 0.88 },
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
  frame: (hue) => ({
    position: 'relative',
    aspectRatio: '16/9',
    borderRadius: 18,
    overflow: 'hidden',
    background: `oklch(8% 0.03 ${hue})`,
    border: '1px solid rgba(255,255,255,0.06)',
    boxShadow: '0 32px 80px rgba(0,0,0,0.55)',
  }),
  frameImg: {
    position: 'absolute', inset: 0,
    width: '100%', height: '100%',
    objectFit: 'cover',
    objectPosition: 'center 30%',
    filter: 'blur(2px) saturate(105%)',
    transform: 'scale(1.06)',
    display: 'block',
  },
  frameScrim: (hue) => ({
    position: 'absolute', inset: 0,
    background: `
      linear-gradient(180deg, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.55) 100%),
      linear-gradient(180deg, oklch(14% 0.05 ${hue} / 0.35) 0%, transparent 60%)
    `,
    pointerEvents: 'none',
  }),
  laneWrap: (topPct) => ({
    position: 'absolute',
    left: 0, right: 0,
    top: `${topPct}%`,
    height: 22,
    overflow: 'hidden',
    pointerEvents: 'none',
  }),
  laneTrack: (dir, duration) => ({
    display: 'flex',
    gap: 40,
    width: 'max-content',
    animation: `danmakuLane${dir} ${duration}s linear infinite`,
  }),
  laneItem: (size, opacity) => ({
    fontFamily: "'DM Sans', sans-serif",
    fontSize: size,
    color: '#fff',
    opacity,
    textShadow: '1px 1px 3px rgba(0,0,0,0.92)',
    whiteSpace: 'nowrap',
  }),
  pinned: (x, y, size, opacity) => ({
    position: 'absolute',
    left: `${x}%`, top: `${y}%`,
    fontFamily: "'DM Sans', sans-serif",
    fontSize: size,
    color: '#fff',
    opacity,
    textShadow: '0 1px 2px rgba(0,0,0,0.95), 0 0 8px rgba(0,0,0,0.75)',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
    fontWeight: 500,
    animation: 'danmakuPinFade 600ms var(--ease-out-expo) both',
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

export default function DanmakuInsert({ poster }) {
  const { lang, t } = useLang()
  const hue = poster?.posterAccent ?? FALLBACK_HUE
  const title = (poster ? pickTitle(poster, lang) : '') || (lang === 'en' ? 'A frozen frame' : '精选一帧')
  return (
    <section style={s.section} aria-labelledby="danmaku-title">
      <style>{`
        @keyframes danmakuLaneL { 0% { transform: translateX(0); } 100% { transform: translateX(-50%); } }
        @keyframes danmakuPinFade {
          0%   { opacity: 0; transform: translateY(4px); }
          100% { opacity: var(--pin-op, 0.7); transform: translateY(0); }
        }
        .danmaku-frame:hover .danmaku-track { animation-play-state: paused; }
        @media (prefers-reduced-motion: reduce) {
          .danmaku-track { animation: none !important; }
          .danmaku-pin { animation: none !important; }
        }
      `}</style>
      <span style={s.sectionNum} aria-hidden>§07</span>
      <div className="container">
        <h2 id="danmaku-title" style={{
          fontFamily: "'Sora', sans-serif",
          fontSize: 'clamp(2rem, 1rem + 3vw, 3.25rem)',
          fontWeight: 800, color: '#fff',
          letterSpacing: '-0.03em', lineHeight: 1.1,
          maxWidth: 560, marginBottom: 48,
        }}>
          {t('landing.danmaku.title')}
        </h2>

        <div className="danmaku-frame" style={s.frame(hue)} aria-hidden="true">
          {poster?.coverImageUrl ? (
            <img
              src={poster.bannerImageUrl || poster.coverImageUrl}
              alt=""
              style={s.frameImg}
              loading="lazy"
            />
          ) : null}
          <div style={s.frameScrim(hue)} aria-hidden />

          <div style={s.corner}>
            <span>{title} · 21:43</span>
            <span>{t('landing.danmaku.cornerLive')}</span>
          </div>

          <div style={s.laneWrap(18)}>
            <div className="danmaku-track" style={s.laneTrack('L', 52)}>
              {[...laneTop, ...laneTop].map((t, i) => (
                <span key={`top-${i}`} style={s.laneItem(15, 1)}>{t}</span>
              ))}
            </div>
          </div>

          {pinned.map((d, i) => (
            <span
              key={`pin-${i}`}
              className="danmaku-pin"
              style={{
                ...s.pinned(d.x, d.y, d.size, d.op),
                animationDelay: `${600 + i * 180}ms`,
                '--pin-op': d.op,
              }}
            >
              {d.t}
            </span>
          ))}

          <div style={s.bottomBar} aria-hidden>
            <div style={s.bottomBarFill} />
          </div>
        </div>

        <div style={s.caption}>
          <div style={s.capLabel}>{t('landing.danmaku.capLabel')}</div>
          <p style={s.capText}>
            {t('landing.danmaku.capTextPrefix')}{title}{t('landing.danmaku.capTextSuffix')}
          </p>
        </div>
      </div>
    </section>
  )
}

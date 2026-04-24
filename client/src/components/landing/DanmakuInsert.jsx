/**
 * §07 · Danmaku Insert — magazine-style frozen 16:9 with 3 lanes + pinned quotes.
 * HUD family: single hue=195 (cyan) drives chrome (SectionNum, ChapterBar, scrim
 * tint, bottom relay bar, corner LIVE dot). Cover image carries visual identity;
 * hue-195 is deliberately separate from posterAccent so §07 reads as "the danmaku
 * section", not "another §04 poster variant".
 */

import { motion as Motion, useReducedMotion } from 'motion/react'
import { useLang } from '../../context/LanguageContext'
import { pickTitle } from '../../utils/formatters'
import { mono, HUD_VIEWPORT } from './shared/hud-tokens'
import { SectionNum, SectionHeader, ChapterBar } from './shared/hud'

const SECTION_HUE = 195
// Harmony partners — see Phase A palette plan.
//   P2 Chatter Rose      → accent on one pinned danmaku (transient pop)
//   P3 Mint Lemon Spark  → right edge of density-peak bar (traffic highlight)
const HUE_ROSE = 330
const HUE_MINT = 95

const laneTop = [
  '这镜头绝了', '芙莉莲会心一击', 'op 泪目', '这作画给跪了',
  '周日晚上刚需', '这分镜不得了', '眼泪止不住', '同步率 101%',
]

const laneMid = [
  '画的是光不是人', '这段 BGM 谁顶得住', '前面高能', '这帧截下来当壁纸',
  '原作这里只有半页', '导演在说话', '手绘的胜利', '节奏稳得像呼吸',
]

const laneBot = [
  '这台词我记一辈子', '没想到会在这集哭', '对视 0.8 秒', '光打在左脸',
  '动画组今晚喝酒', '这分镜像做梦', '一话顶一部', '这段必吹',
]

// Pinned "frozen" danmaku — evoking "一帧里,三千条人声" without
// turning the panel into a scrolling LED ticker.
// One "pop" pin carries chatter-rose as a transient accent against the cyan HUD.
const pinned = [
  { t: '每周日就等这个', x: 14, y: 44, size: 13, op: 0.95 },
  { t: '这分镜不得不服', x: 52, y: 58, size: 14, op: 1, pop: true },
  { t: 'op 又来了泪目',  x: 28, y: 72, size: 12, op: 0.88 },
]

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
  },
  headerOverride: {
    marginBottom: 0,
  },
  frame: {
    position: 'relative',
    aspectRatio: '16/9',
    borderRadius: 18,
    overflow: 'hidden',
    background: `oklch(8% 0.03 ${SECTION_HUE})`,
    border: '1px solid rgba(255,255,255,0.06)',
    boxShadow: '0 32px 80px rgba(0,0,0,0.55)',
  },
  frameImg: {
    position: 'absolute', inset: 0,
    width: '100%', height: '100%',
    objectFit: 'cover',
    objectPosition: 'center 30%',
    filter: 'blur(2px) saturate(105%)',
    transform: 'scale(1.06)',
    display: 'block',
  },
  frameScrim: {
    position: 'absolute', inset: 0,
    background: `
      linear-gradient(180deg, rgba(0,0,0,0.18) 0%, rgba(0,0,0,0.58) 100%),
      linear-gradient(180deg, oklch(14% 0.05 ${SECTION_HUE} / 0.38) 0%, transparent 60%)
    `,
    pointerEvents: 'none',
  },
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
  pinned: (x, y, size, opacity, pop) => ({
    position: 'absolute',
    left: `${x}%`, top: `${y}%`,
    fontFamily: "'DM Sans', sans-serif",
    fontSize: size,
    color: pop ? `oklch(78% 0.10 ${HUE_ROSE})` : '#fff',
    opacity,
    textShadow: pop
      ? `0 1px 2px rgba(0,0,0,0.95), 0 0 10px oklch(60% 0.14 ${HUE_ROSE} / 0.55)`
      : '0 1px 2px rgba(0,0,0,0.95), 0 0 8px rgba(0,0,0,0.75)',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
    fontWeight: pop ? 600 : 500,
    animation: 'danmakuPinFade 600ms var(--ease-out-expo) both',
  }),
  corner: {
    position: 'absolute',
    top: 18, left: 20, right: 20,
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    gap: 16,
    ...mono,
    fontSize: 10, letterSpacing: '0.14em',
    color: 'rgba(255,255,255,0.60)',
    pointerEvents: 'none',
  },
  cornerLeft: {
    display: 'inline-flex', alignItems: 'center', gap: 8,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  cornerLive: {
    display: 'inline-flex', alignItems: 'center', gap: 8,
    color: `oklch(84% 0.09 ${SECTION_HUE})`,
    whiteSpace: 'nowrap',
  },
  cornerLiveDot: {
    width: 6, height: 6, borderRadius: 9999,
    background: `oklch(68% 0.13 ${SECTION_HUE})`,
    boxShadow: `0 0 10px oklch(68% 0.13 ${SECTION_HUE} / 0.7)`,
    animation: 'hudBlink 2.2s var(--ease-out-expo) infinite',
  },
  cornerSep: {
    color: 'rgba(255,255,255,0.25)',
  },
  cornerRate: {
    color: 'rgba(255,255,255,0.50)',
    whiteSpace: 'nowrap',
  },
  bottomBar: {
    position: 'absolute',
    left: 20, right: 20, bottom: 18,
    height: 3, borderRadius: 2,
    background: 'rgba(255,255,255,0.12)',
    overflow: 'hidden',
  },
  bottomBarFill: {
    position: 'absolute',
    inset: 0,
    background: `linear-gradient(90deg, oklch(68% 0.13 ${SECTION_HUE}) 0%, oklch(78% 0.11 ${SECTION_HUE}) 60%, oklch(88% 0.09 ${HUE_MINT}) 100%)`,
    transformOrigin: 'left',
  },
  caption: {
    marginTop: 32,
    display: 'grid',
    gridTemplateColumns: 'auto 1fr',
    gap: 16,
    alignItems: 'baseline',
  },
  capLabel: {
    ...mono,
    fontSize: 11,
    color: `oklch(74% 0.11 ${SECTION_HUE} / 0.75)`,
    letterSpacing: '0.12em',
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
  const reduced = useReducedMotion()
  const title = (poster ? pickTitle(poster, lang) : '') || (lang === 'en' ? 'A frozen frame' : '精选一帧')
  return (
    <section style={s.section} aria-labelledby="danmaku-title">
      <style>{`
        @keyframes danmakuLaneL { 0% { transform: translateX(0); } 100% { transform: translateX(-50%); } }
        @keyframes danmakuLaneR { 0% { transform: translateX(-50%); } 100% { transform: translateX(0); } }
        @keyframes danmakuPinFade {
          0%   { opacity: 0; transform: translateY(4px); }
          100% { opacity: var(--pin-op, 0.7); transform: translateY(0); }
        }
        .danmaku-frame:hover .danmaku-track { animation-play-state: paused; }
        @media (max-width: 480px) {
          .danmaku-lane-mid { display: none; }
        }
        @media (prefers-reduced-motion: reduce) {
          .danmaku-track { animation: none !important; }
          .danmaku-pin { animation: none !important; opacity: var(--pin-op, 0.7) !important; }
        }
      `}</style>
      <SectionNum n="07" />
      <div className="container">
        <div style={s.headerWrap}>
          <ChapterBar hue={SECTION_HUE} style={{ top: 0, left: 0 }} />
          <SectionHeader
            eyebrow={t('landing.danmaku.eyebrow')}
            title={t('landing.danmaku.title')}
            titleId="danmaku-title"
            style={s.headerOverride}
          />
        </div>

        <div className="danmaku-frame" style={s.frame} aria-hidden="true">
          {poster?.coverImageUrl ? (
            <img
              src={poster.bannerImageUrl || poster.coverImageUrl}
              alt=""
              style={s.frameImg}
              loading="lazy"
            />
          ) : null}
          <div style={s.frameScrim} aria-hidden />

          <div style={s.corner}>
            <span style={s.cornerLeft}>{title} · 21:43</span>
            <span style={s.cornerLive}>
              <span style={s.cornerLiveDot} className="hud-blink" aria-hidden />
              {t('landing.danmaku.cornerLive')}
              <span style={s.cornerSep}>·</span>
              <span style={s.cornerRate}>{t('landing.danmaku.cornerRate')}</span>
            </span>
          </div>

          <div style={s.laneWrap(14)}>
            <div className="danmaku-track" style={s.laneTrack('L', 52)}>
              {[...laneTop, ...laneTop].map((tx, i) => (
                <span key={`top-${i}`} style={s.laneItem(15, 1)}>{tx}</span>
              ))}
            </div>
          </div>

          <div className="danmaku-lane-mid" style={s.laneWrap(28)}>
            <div className="danmaku-track" style={s.laneTrack('R', 64)}>
              {[...laneMid, ...laneMid].map((tx, i) => (
                <span key={`mid-${i}`} style={s.laneItem(14, 0.88)}>{tx}</span>
              ))}
            </div>
          </div>

          <div style={s.laneWrap(86)}>
            <div className="danmaku-track" style={s.laneTrack('L', 72)}>
              {[...laneBot, ...laneBot].map((tx, i) => (
                <span key={`bot-${i}`} style={s.laneItem(13, 0.78)}>{tx}</span>
              ))}
            </div>
          </div>

          {pinned.map((d, i) => (
            <span
              key={`pin-${i}`}
              className="danmaku-pin"
              style={{
                ...s.pinned(d.x, d.y, d.size, d.op, d.pop),
                animationDelay: `${600 + i * 180}ms`,
                '--pin-op': d.op,
              }}
            >
              {d.t}
            </span>
          ))}

          <div style={s.bottomBar} aria-hidden>
            <Motion.div
              style={s.bottomBarFill}
              initial={reduced ? false : { scaleX: 0 }}
              whileInView={reduced ? undefined : { scaleX: 0.38 }}
              viewport={HUD_VIEWPORT}
              transition={{ duration: 1.4, delay: 0.25, ease: [0.33, 1, 0.68, 1] }}
            />
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

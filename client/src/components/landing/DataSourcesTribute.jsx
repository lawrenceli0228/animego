/**
 * §03 · Data Sources Tribute
 * 48 sources across two reverse-direction marquee rows. Upgraded to HUD family:
 * single hue=40 signature, shared ChapterBar + SectionNum + SectionHeader,
 * chips are now SystemNodes (live-dot + idx + name + latency readout),
 * footer shows a relay bar with a count-up on the node total.
 * Source names stay verbatim across locales — they are proper nouns.
 */

import { motion as Motion, useReducedMotion } from 'motion/react'
import { useLang } from '../../context/LanguageContext'
import { mono, label, useCountUp, HUD_VIEWPORT } from './shared/hud-tokens'
import { SectionNum, SectionHeader, ChapterBar } from './shared/hud'

const SECTION_HUE = 40

const rowA = [
  'AniList', 'Bangumi', '弹弹Play', 'TMDb', 'AniDB', 'Kitsu',
  '动漫花园', '豌豆字幕', 'LoliHouse', 'NC-Raws', 'Lilith-Raws', 'ANi',
  '喵萌奶茶屋', '桜都字幕組', 'VCB-Studio', '千夏字幕组', 'DMhY', 'Mikan Project',
  '漫猫字幕社', '澄空学园', '极影字幕社', '悠哈璃羽', '萌番组', '北宇治字幕组',
]

const rowB = [
  'Bilibili', 'AcFun', '爱奇艺', '腾讯视频', '优酷', 'B 站国创',
  'Simkl', 'LiveChart', 'AniSearch', 'MyAnimeList', 'Anime News Network', '动漫之家',
  'MAL CDN', 'AniList CDN', 'TMDB Images', 'nyaa.si', 'Bangumi.moe', '动漫国字幕组',
  '风之圣殿', '花园字幕', '雪飄工作室', '诸神字幕组', '白目魔法屋', 'Gugugu Subs',
]

/* Fake-but-believable latencies per source index. Static (not measured live) — the
 * point is giving each chip a distinct numeric identity, not a dashboard. */
const LATENCIES = [
  142, 98, 71, 180, 165, 112, 84, 203, 156, 119, 132, 94,
  168, 145, 176, 103, 127, 88, 152, 139, 197, 115, 91, 147,
  108, 164, 122, 189, 173, 96, 131, 157, 144, 102, 118, 183,
  125, 149, 111, 167, 134, 95, 178, 121, 106, 192, 153, 137,
]

const s = {
  section: {
    position: 'relative',
    padding: 'clamp(72px, 6vw, 104px) 0',
    background: '#000',
    borderTop: '1px solid rgba(84,84,88,0.30)',
    borderBottom: '1px solid rgba(84,84,88,0.30)',
    overflow: 'hidden',
  },
  headerWrap: {
    position: 'relative',
    paddingLeft: 20,
  },
  marqueeWrap: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    maskImage: 'linear-gradient(90deg, transparent 0, #000 8%, #000 92%, transparent 100%)',
    WebkitMaskImage: 'linear-gradient(90deg, transparent 0, #000 8%, #000 92%, transparent 100%)',
  },
  track: (dir, duration) => ({
    display: 'flex',
    gap: 14,
    width: 'max-content',
    animation: `tributeScroll${dir} ${duration}s linear infinite`,
  }),
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 14px',
    borderRadius: 8,
    border: '1px solid rgba(84,84,88,0.45)',
    background: 'rgba(255,255,255,0.02)',
    fontFamily: "'DM Sans', sans-serif",
    fontSize: 13,
    fontWeight: 500,
    color: 'rgba(235,235,245,0.72)',
    whiteSpace: 'nowrap',
    transition: 'all 200ms var(--ease-out-expo)',
    cursor: 'default',
  },
  chipDot: {
    width: 6, height: 6, borderRadius: 9999,
    background: `oklch(62% 0.19 ${SECTION_HUE})`,
    boxShadow: `0 0 8px oklch(62% 0.19 ${SECTION_HUE} / 0.6)`,
    flexShrink: 0,
    animation: 'hudBlink 2.4s var(--ease-out-expo) infinite',
    animationDelay: 'var(--blink-delay, 0s)',
  },
  chipIdx: {
    ...mono,
    fontSize: 10,
    color: 'rgba(235,235,245,0.30)',
    letterSpacing: '0.06em',
  },
  chipName: {
    flex: '0 0 auto',
  },
  chipSep: {
    color: 'rgba(235,235,245,0.18)',
    margin: '0 2px',
  },
  chipLatency: {
    ...mono,
    fontSize: 10,
    color: `oklch(72% 0.15 ${SECTION_HUE} / 0.75)`,
    letterSpacing: '0.06em',
  },
  footer: {
    marginTop: 56,
    paddingTop: 24,
    borderTop: '1px solid rgba(84,84,88,0.30)',
    display: 'grid',
    gridTemplateColumns: 'auto 1fr auto',
    columnGap: 24,
    rowGap: 8,
    alignItems: 'center',
  },
  footerNodes: {
    ...mono,
    fontSize: 12,
    letterSpacing: '0.1em',
    color: 'rgba(235,235,245,0.70)',
  },
  footerNodesNum: {
    color: `oklch(75% 0.15 ${SECTION_HUE})`,
    fontWeight: 600,
  },
  footerBarWrap: {
    position: 'relative',
    height: 4,
    background: 'rgba(235,235,245,0.08)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  footerBarFill: {
    position: 'absolute',
    inset: 0,
    background: `linear-gradient(90deg, oklch(62% 0.19 ${SECTION_HUE} / 0.8) 0%, oklch(62% 0.19 ${SECTION_HUE} / 0.3) 100%)`,
    transformOrigin: 'left',
  },
  footerStatus: {
    ...label,
    fontSize: 10,
    color: 'rgba(235,235,245,0.45)',
  },
  // Visually hidden but available to assistive tech
  srOnly: {
    position: 'absolute',
    width: 1, height: 1, padding: 0, margin: -1,
    overflow: 'hidden', clip: 'rect(0, 0, 0, 0)',
    whiteSpace: 'nowrap', border: 0,
  },
}

function SystemNode({ name, idx, latency, blinkPhase }) {
  const hover = (e) => {
    e.currentTarget.style.borderColor = `oklch(62% 0.19 ${SECTION_HUE} / 0.55)`
    e.currentTarget.style.background = `oklch(62% 0.19 ${SECTION_HUE} / 0.08)`
    e.currentTarget.style.color = '#fff'
  }
  const leave = (e) => {
    e.currentTarget.style.borderColor = 'rgba(84,84,88,0.45)'
    e.currentTarget.style.background = 'rgba(255,255,255,0.02)'
    e.currentTarget.style.color = 'rgba(235,235,245,0.72)'
  }
  return (
    <span style={s.chip} onMouseEnter={hover} onMouseLeave={leave}>
      <span
        className="hud-blink"
        style={{ ...s.chipDot, '--blink-delay': `${blinkPhase}s` }}
        aria-hidden
      />
      <span style={s.chipIdx}>{String(idx + 1).padStart(2, '0')}</span>
      <span style={s.chipName}>{name}</span>
      <span style={s.chipSep}>·</span>
      <span style={s.chipLatency}>{latency}ms</span>
    </span>
  )
}

function Footer() {
  const reduced = useReducedMotion()
  const { t } = useLang()
  const [countRef, nodes] = useCountUp(48, { duration: 1.4, delay: 0.2 })
  return (
    <div className="tribute-footer" style={s.footer}>
      <div ref={countRef} style={s.footerNodes}>
        <span style={s.footerNodesNum}>{nodes}</span>{' '}
        {t('landing.tribute.footerNodesSuffix')} · 03 RELAY · FAIL-OVER READY
      </div>
      <div style={s.footerBarWrap}>
        <Motion.div
          style={s.footerBarFill}
          initial={reduced ? false : { scaleX: 0 }}
          whileInView={reduced ? undefined : { scaleX: 1 }}
          viewport={HUD_VIEWPORT}
          transition={{ duration: 1.4, delay: 0.2, ease: [0.33, 1, 0.68, 1] }}
        />
      </div>
      <div style={s.footerStatus}>{t('landing.tribute.footerStatus')}</div>
    </div>
  )
}

export default function DataSourcesTribute() {
  const { t } = useLang()
  const doubledA = [...rowA, ...rowA]
  const doubledB = [...rowB, ...rowB]

  return (
    <section style={s.section} aria-labelledby="tribute-title">
      <style>{`
        @keyframes tributeScrollA {
          0%   { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        @keyframes tributeScrollB {
          0%   { transform: translateX(-50%); }
          100% { transform: translateX(0); }
        }
        .tribute-marquee:hover .tribute-track {
          animation-play-state: paused;
        }
        @media (prefers-reduced-motion: reduce) {
          .tribute-track {
            animation: none !important;
            transform: none !important;
            flex-wrap: wrap;
            width: 100% !important;
            justify-content: center;
          }
          .tribute-wrap {
            mask-image: none !important;
            -webkit-mask-image: none !important;
          }
        }
        @media (max-width: 520px) {
          .tribute-footer {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
      <SectionNum n="03" />

      <div className="container">
        <div style={s.headerWrap}>
          <ChapterBar hue={SECTION_HUE} style={{ top: 0, left: 0 }} />
          <SectionHeader
            eyebrow={t('landing.tribute.eyebrow')}
            title={t('landing.tribute.title')}
            sub={t('landing.tribute.sub')}
            titleId="tribute-title"
          />
        </div>

        <ul style={s.srOnly} aria-label={t('landing.tribute.srLabel')}>
          {[...rowA, ...rowB].map((name, i) => (
            <li key={`sr-${i}`}>{name}</li>
          ))}
        </ul>

        <div className="tribute-marquee tribute-wrap" style={s.marqueeWrap} aria-hidden="true">
          <div className="tribute-track" style={s.track('A', 60)}>
            {doubledA.map((name, i) => {
              const baseIdx = i % rowA.length
              return (
                <SystemNode
                  key={`a-${i}`}
                  name={name}
                  idx={baseIdx}
                  latency={LATENCIES[baseIdx]}
                  blinkPhase={((baseIdx * 0.31) % 2.4).toFixed(2)}
                />
              )
            })}
          </div>
          <div className="tribute-track" style={s.track('B', 72)}>
            {doubledB.map((name, i) => {
              const baseIdx = i % rowB.length
              return (
                <SystemNode
                  key={`b-${i}`}
                  name={name}
                  idx={baseIdx + rowA.length}
                  latency={LATENCIES[baseIdx + rowA.length]}
                  blinkPhase={((baseIdx * 0.41 + 1.1) % 2.4).toFixed(2)}
                />
              )
            })}
          </div>
        </div>

        <Footer />
      </div>
    </section>
  )
}

/**
 * §03 · Data Sources Tribute
 * 48 sources as a two-row reverse marquee with mono index + hue dot.
 * Source names stay verbatim across locales — they are proper nouns.
 */

import { useLang } from '../../context/LanguageContext'

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

const hues = [330, 40, 155, 210]

const s = {
  section: {
    position: 'relative',
    padding: 'clamp(72px, 6vw, 104px) 0',
    background: '#000',
    borderTop: '1px solid rgba(84,84,88,0.30)',
    borderBottom: '1px solid rgba(84,84,88,0.30)',
    overflow: 'hidden',
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
  header: {
    maxWidth: 760,
    marginBottom: 56,
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
    fontSize: 'clamp(1.875rem, 1rem + 2.5vw, 3rem)',
    fontWeight: 800,
    color: '#fff',
    letterSpacing: '-0.03em',
    lineHeight: 1.1,
    marginBottom: 16,
  },
  sub: {
    fontSize: 15,
    color: 'rgba(235,235,245,0.60)',
    lineHeight: 1.6,
    maxWidth: 560,
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
  chip: (hue) => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 16px',
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
    '--chip-hue': hue,
  }),
  chipDot: (hue) => ({
    width: 6, height: 6, borderRadius: 9999,
    background: `oklch(62% 0.19 ${hue})`,
    boxShadow: `0 0 8px oklch(62% 0.19 ${hue} / 0.6)`,
    flexShrink: 0,
  }),
  chipIdx: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10,
    color: 'rgba(235,235,245,0.30)',
    letterSpacing: '0.06em',
  },
  footer: {
    marginTop: 48,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 12,
    paddingTop: 20,
    borderTop: '1px solid rgba(84,84,88,0.30)',
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    color: 'rgba(235,235,245,0.30)',
    letterSpacing: '0.08em',
  },
  footerNum: {
    color: 'rgba(235,235,245,0.60)',
    fontWeight: 500,
  },
  // Visually hidden but available to assistive tech
  srOnly: {
    position: 'absolute',
    width: 1, height: 1, padding: 0, margin: -1,
    overflow: 'hidden', clip: 'rect(0, 0, 0, 0)',
    whiteSpace: 'nowrap', border: 0,
  },
}

function Chip({ label, idx, hue }) {
  const hover = (e) => {
    e.currentTarget.style.borderColor = `oklch(62% 0.19 ${hue} / 0.55)`
    e.currentTarget.style.background = `oklch(62% 0.19 ${hue} / 0.08)`
    e.currentTarget.style.color = '#fff'
  }
  const leave = (e) => {
    e.currentTarget.style.borderColor = 'rgba(84,84,88,0.45)'
    e.currentTarget.style.background = 'rgba(255,255,255,0.02)'
    e.currentTarget.style.color = 'rgba(235,235,245,0.72)'
  }
  return (
    <span style={s.chip(hue)} onMouseEnter={hover} onMouseLeave={leave}>
      <span style={s.chipDot(hue)} aria-hidden />
      <span style={s.chipIdx}>{String(idx + 1).padStart(2, '0')}</span>
      <span>{label}</span>
    </span>
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
      `}</style>
      <span style={s.sectionNum} aria-hidden>§03</span>

      <div className="container">
        <header style={s.header}>
          <div style={s.eyebrow}>{t('landing.tribute.eyebrow')}</div>
          <h2 id="tribute-title" style={s.title}>
            {t('landing.tribute.title')}
          </h2>
          <p style={s.sub}>
            {t('landing.tribute.sub')}
          </p>
        </header>

        <ul style={s.srOnly} aria-label={t('landing.tribute.srLabel')}>
          {[...rowA, ...rowB].map((label) => (
            <li key={`sr-${label}`}>{label}</li>
          ))}
        </ul>

        <div className="tribute-marquee tribute-wrap" style={s.marqueeWrap} aria-hidden="true">
          <div className="tribute-track" style={s.track('A', 60)}>
            {doubledA.map((label, i) => (
              <Chip
                key={`a-${i}`}
                label={label}
                idx={i % rowA.length}
                hue={hues[i % hues.length]}
              />
            ))}
          </div>
          <div className="tribute-track" style={s.track('B', 72)}>
            {doubledB.map((label, i) => (
              <Chip
                key={`b-${i}`}
                label={label}
                idx={(i % rowB.length) + rowA.length}
                hue={hues[(i + 2) % hues.length]}
              />
            ))}
          </div>
        </div>

        <div style={s.footer}>
          <span>{t('landing.tribute.footerCount')}</span>
          <span>{t('landing.tribute.footerThanks')}</span>
        </div>
      </div>
    </section>
  )
}

import { useState } from 'react'
import { formatScore, stripHtml, truncate, pickTitle } from '../../utils/formatters'
import { useLang } from '../../context/LanguageContext'

const scoreColor = (s) => s >= 75 ? '#22c55e' : s >= 50 ? '#eab308' : '#ef4444'

export default function AnimeDetailHero({ anime }) {
  const [expanded, setExpanded] = useState(false)
  const { t, lang } = useLang()
  const {
    titleRomaji, titleEnglish, titleNative,
    coverImageUrl, bannerImageUrl, description,
    episodes, status, season, seasonYear,
    averageScore, genres = [], format, bgmId
  } = anime

  const desc = stripHtml(description || '')
  const displayDesc = expanded ? desc : truncate(desc, 300)
  const statusLabel = {
    RELEASING: t('detail.releasing'), FINISHED: t('detail.finished'),
    NOT_YET_RELEASED: t('detail.notYetReleased'), CANCELLED: t('detail.cancelled')
  }[status] || status

  return (
    <div>
      {/* Banner */}
      <div style={{
        position:'relative', height: bannerImageUrl ? 400 : 120,
        background: bannerImageUrl ? `url(${bannerImageUrl}) center/cover` : 'linear-gradient(135deg,#1a1040,#0a1628)',
        overflow:'hidden'
      }}>
        <div style={{
          position:'absolute', inset:0,
          background:'linear-gradient(to bottom, rgba(10,14,26,0.15) 0%, rgba(10,14,26,0.75) 100%)'
        }} />
      </div>

      {/* Content */}
      <div className="container" style={{ display:'flex', gap:32, marginTop: bannerImageUrl ? -80 : 24, position:'relative', zIndex:1, paddingBottom:40 }}>
        {/* Cover */}
        <div style={{ flexShrink:0 }}>
          <img src={coverImageUrl} alt={titleRomaji}
            style={{ width:210, height:300, objectFit:'cover', borderRadius:6,
              border:'3px solid rgba(10,132,255,0.4)',
              boxShadow:'0 20px 50px rgba(0,0,0,0.6)' }}
            onError={e => { e.target.style.background='#2c2c2e' }}
          />
        </div>

        {/* Meta */}
        <div style={{ flex:1, paddingTop: bannerImageUrl ? 60 : 0 }}>
          <h1 style={{ fontSize:'clamp(22px,4vw,36px)', color:'#ffffff', marginBottom:4 }}>
            {pickTitle(anime, lang)}
          </h1>
          {lang === 'zh' && titleNative && <p style={{ color:'rgba(235,235,245,0.60)', fontSize:15, marginBottom:16 }}>{titleNative}</p>}

          {/* Badges row */}
          <div style={{ display:'flex', flexWrap:'wrap', gap:10, marginBottom:20 }}>
            {averageScore && (
              <span style={{ padding:'4px 12px', borderRadius:20, background:'rgba(34,197,94,0.15)',
                color: scoreColor(averageScore), fontWeight:700, fontSize:14, border:`1px solid ${scoreColor(averageScore)}40` }}>
                ★ {formatScore(averageScore)}
              </span>
            )}
            {format && <span style={{ padding:'4px 12px', borderRadius:20, background:'rgba(10,132,255,0.15)',
              color:'#60aaff', fontSize:13, border:'1px solid rgba(10,132,255,0.3)' }}>{format}</span>}
            {status && <span style={{ padding:'4px 12px', borderRadius:20, background:'rgba(90,200,250,0.1)',
              color:'#5ac8fa', fontSize:13, border:'1px solid rgba(90,200,250,0.3)' }}>{statusLabel}</span>}
            {episodes && <span style={{ padding:'4px 12px', borderRadius:20, background:'rgba(148,163,184,0.08)',
              color:'rgba(235,235,245,0.60)', fontSize:13 }}>{episodes} {t('detail.epUnit')}</span>}
            {season && seasonYear && <span style={{ padding:'4px 12px', borderRadius:20,
              background:'rgba(148,163,184,0.08)', color:'rgba(235,235,245,0.60)', fontSize:13 }}>
              {t(`season.${season}`)} {seasonYear}
            </span>}
            {bgmId && (
              <a
                href={`https://bgm.tv/subject/${bgmId}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  padding:'4px 12px', borderRadius:20,
                  background:'rgba(239,68,68,0.12)', color:'#f87171', fontSize:13,
                  border:'1px solid rgba(239,68,68,0.3)', textDecoration:'none',
                  display:'inline-flex', alignItems:'center', gap:4, fontWeight:500
                }}
                onMouseEnter={e => { e.currentTarget.style.background='rgba(239,68,68,0.22)'; e.currentTarget.style.borderColor='rgba(239,68,68,0.5)' }}
                onMouseLeave={e => { e.currentTarget.style.background='rgba(239,68,68,0.12)'; e.currentTarget.style.borderColor='rgba(239,68,68,0.3)' }}
              >
                <span style={{ fontSize:10, opacity:0.8 }}>▶</span>
                {t('detail.viewOnBgm')}
              </a>
            )}
          </div>

          {/* Genres */}
          <div style={{ display:'flex', flexWrap:'wrap', gap:6, marginBottom:20 }}>
            {genres.map(g => (
              <span key={g} style={{ padding:'4px 12px', borderRadius:6,
                background:'rgba(10,132,255,0.12)', color:'#90c8ff', fontSize:12,
                border:'1px solid rgba(10,132,255,0.2)', fontWeight:500 }}>{g}</span>
            ))}
          </div>

          {/* Description */}
          {desc && (
            <div>
              <p style={{ color:'rgba(235,235,245,0.60)', fontSize:14, lineHeight:1.8 }}>{displayDesc}</p>
              {desc.length > 300 && (
                <button onClick={() => setExpanded(!expanded)}
                  style={{ color:'#0a84ff', fontSize:13, fontWeight:600, marginTop:8, cursor:'pointer',
                    background:'none', border:'none', padding:0 }}>
                  {expanded ? t('detail.collapse') : t('detail.readMore')}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

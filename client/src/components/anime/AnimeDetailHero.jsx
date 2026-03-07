import { useState } from 'react'
import { formatScore, formatSeason, stripHtml, truncate } from '../../utils/formatters'
import { STATUS_OPTIONS } from '../../utils/constants'

const scoreColor = (s) => s >= 75 ? '#22c55e' : s >= 50 ? '#eab308' : '#ef4444'

export default function AnimeDetailHero({ anime }) {
  const [expanded, setExpanded] = useState(false)
  const {
    titleRomaji, titleEnglish, titleNative,
    coverImageUrl, bannerImageUrl, description,
    episodes, status, season, seasonYear,
    averageScore, genres = [], format
  } = anime

  const desc = stripHtml(description || '')
  const displayDesc = expanded ? desc : truncate(desc, 300)
  const statusLabel = { RELEASING:'连载中', FINISHED:'已完结', NOT_YET_RELEASED:'未开播', CANCELLED:'已取消' }[status] || status

  return (
    <div>
      {/* Banner */}
      <div style={{
        position:'relative', height: bannerImageUrl ? 320 : 120,
        background: bannerImageUrl ? `url(${bannerImageUrl}) center/cover` : 'linear-gradient(135deg,#1a1040,#0a1628)',
        overflow:'hidden'
      }}>
        <div style={{
          position:'absolute', inset:0,
          background:'linear-gradient(to bottom, rgba(10,14,26,0.2) 0%, rgba(10,14,26,0.95) 100%)'
        }} />
      </div>

      {/* Content */}
      <div className="container" style={{ display:'flex', gap:32, marginTop: bannerImageUrl ? -80 : 24, position:'relative', zIndex:1, paddingBottom:40 }}>
        {/* Cover */}
        <div style={{ flexShrink:0 }}>
          <img src={coverImageUrl} alt={titleRomaji}
            style={{ width:180, height:260, objectFit:'cover', borderRadius:12,
              border:'3px solid rgba(124,58,237,0.4)',
              boxShadow:'0 20px 50px rgba(0,0,0,0.6)' }}
            onError={e => { e.target.style.background='#1a2235' }}
          />
        </div>

        {/* Meta */}
        <div style={{ flex:1, paddingTop: bannerImageUrl ? 60 : 0 }}>
          <h1 style={{ fontSize:'clamp(22px,4vw,36px)', color:'#f1f5f9', marginBottom:4 }}>
            {titleEnglish || titleRomaji}
          </h1>
          {titleNative && <p style={{ color:'#94a3b8', fontSize:15, marginBottom:16 }}>{titleNative}</p>}

          {/* Badges row */}
          <div style={{ display:'flex', flexWrap:'wrap', gap:10, marginBottom:20 }}>
            {averageScore && (
              <span style={{ padding:'4px 12px', borderRadius:20, background:'rgba(34,197,94,0.15)',
                color: scoreColor(averageScore), fontWeight:700, fontSize:14, border:`1px solid ${scoreColor(averageScore)}40` }}>
                ★ {formatScore(averageScore)}
              </span>
            )}
            {format && <span style={{ padding:'4px 12px', borderRadius:20, background:'rgba(124,58,237,0.15)',
              color:'#a78bfa', fontSize:13, border:'1px solid rgba(124,58,237,0.3)' }}>{format}</span>}
            {status && <span style={{ padding:'4px 12px', borderRadius:20, background:'rgba(6,182,212,0.1)',
              color:'#22d3ee', fontSize:13, border:'1px solid rgba(6,182,212,0.3)' }}>{statusLabel}</span>}
            {episodes && <span style={{ padding:'4px 12px', borderRadius:20, background:'rgba(148,163,184,0.08)',
              color:'#94a3b8', fontSize:13 }}>{episodes} 集</span>}
            {season && seasonYear && <span style={{ padding:'4px 12px', borderRadius:20,
              background:'rgba(148,163,184,0.08)', color:'#94a3b8', fontSize:13 }}>
              {formatSeason(season, seasonYear)}
            </span>}
          </div>

          {/* Genres */}
          <div style={{ display:'flex', flexWrap:'wrap', gap:6, marginBottom:20 }}>
            {genres.map(g => (
              <span key={g} style={{ padding:'4px 12px', borderRadius:6,
                background:'rgba(124,58,237,0.12)', color:'#c4b5fd', fontSize:12,
                border:'1px solid rgba(124,58,237,0.2)', fontWeight:500 }}>{g}</span>
            ))}
          </div>

          {/* Description */}
          {desc && (
            <div>
              <p style={{ color:'#94a3b8', fontSize:14, lineHeight:1.8 }}>{displayDesc}</p>
              {desc.length > 300 && (
                <button onClick={() => setExpanded(!expanded)}
                  style={{ color:'#7c3aed', fontSize:13, fontWeight:600, marginTop:8, cursor:'pointer',
                    background:'none', border:'none', padding:0 }}>
                  {expanded ? '收起' : '展开更多'}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

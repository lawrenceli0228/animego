import { useNavigate } from 'react-router-dom'
import { formatScore, pickTitle } from '../../utils/formatters'
import { useLang } from '../../context/LanguageContext'

const scoreColor = (s) => s >= 75 ? '#22c55e' : s >= 50 ? '#eab308' : '#ef4444'

export default function AnimeCard({ anime, rank, watcherCount }) {
  const navigate = useNavigate()
  const { lang } = useLang()
  const { anilistId, titleRomaji, coverImageUrl, averageScore, genres = [], format } = anime

  return (
    <div
      onClick={() => navigate(`/anime/${anilistId}`)}
      role="button"
      tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && navigate(`/anime/${anilistId}`)}
      aria-label={pickTitle(anime, lang)}
      style={{
        position: 'relative', cursor: 'pointer', borderRadius: 12,
        overflow: 'hidden', background: '#1c1c1e',
        border: '1px solid rgba(148,163,184,0.08)',
        transition: 'transform 0.25s, border-color 0.25s, box-shadow 0.25s',
        aspectRatio: '2/3'
      }}
      onMouseEnter={e => {
        e.currentTarget.style.transform = 'translateY(-4px) scale(1.02)'
        e.currentTarget.style.borderColor = 'rgba(10,132,255,0.5)'
        e.currentTarget.style.boxShadow = '0 16px 40px rgba(10,132,255,0.25)'
        e.currentTarget.querySelector('.card-overlay').style.opacity = '1'
      }}
      onMouseLeave={e => {
        e.currentTarget.style.transform = 'none'
        e.currentTarget.style.borderColor = 'rgba(148,163,184,0.08)'
        e.currentTarget.style.boxShadow = 'none'
        e.currentTarget.querySelector('.card-overlay').style.opacity = '0'
      }}
    >
      {/* Cover image */}
      <img src={coverImageUrl} alt={titleRomaji}
        style={{ width:'100%', height:'100%', objectFit:'cover', display:'block' }}
        onError={e => { e.target.style.background = '#2c2c2e' }}
      />

      {/* Rank badge (replaces format badge when rank is provided) */}
      {rank ? (
        <span style={{
          position:'absolute', top:6, left:8,
          color:'#0a84ff', fontSize:22, fontWeight:900,
          lineHeight:1, textShadow:'0 2px 8px rgba(0,0,0,0.8)',
          fontFamily:"'Sora',sans-serif"
        }}>#{rank}</span>
      ) : format && (
        <span style={{
          position:'absolute', top:8, left:8,
          background:'rgba(10,14,26,0.85)', backdropFilter:'blur(8px)',
          color:'rgba(235,235,245,0.60)', fontSize:10, fontWeight:700,
          padding:'3px 7px', borderRadius:5, letterSpacing:'0.5px'
        }}>{format}</span>
      )}

      {/* Score badge */}
      {averageScore && (
        <span style={{
          position:'absolute', top:8, right:8,
          background:'rgba(10,14,26,0.85)', backdropFilter:'blur(8px)',
          color: scoreColor(averageScore), fontSize:11, fontWeight:700,
          padding:'3px 7px', borderRadius:5
        }}>★ {formatScore(averageScore)}</span>
      )}

      {/* Watcher count badge */}
      {watcherCount > 0 && (
        <span style={{
          position:'absolute', bottom:8, left:8,
          background:'rgba(10,14,26,0.85)', backdropFilter:'blur(8px)',
          color:'#5ac8fa', fontSize:10, fontWeight:700,
          padding:'3px 7px', borderRadius:5
        }}>{watcherCount} 人</span>
      )}

      {/* Permanent bottom gradient — title always visible inside the image */}
      <div style={{
        position:'absolute', bottom:0, left:0, right:0,
        background:'linear-gradient(to top, rgba(10,14,26,0.97) 0%, rgba(10,14,26,0.6) 55%, transparent 100%)',
        padding:'32px 10px 10px'
      }}>
        {/* Genres — revealed on hover */}
        <div className="card-overlay" style={{
          opacity:0, transition:'opacity 0.25s',
          display:'flex', flexWrap:'wrap', gap:4, marginBottom:6
        }}>
          {genres.slice(0,2).map(g => (
            <span key={g} style={{
              fontSize:10, padding:'2px 7px', borderRadius:4,
              background:'rgba(10,132,255,0.3)', color:'#90c8ff', fontWeight:500
            }}>{g}</span>
          ))}
        </div>
        {/* Title — always visible, updates immediately on language switch */}
        <p style={{
          fontFamily:"'DM Sans',sans-serif", fontSize:11, fontWeight:600,
          color:'#ffffff', lineHeight:1.35, margin:0,
          overflow:'hidden', display:'-webkit-box',
          WebkitLineClamp:2, WebkitBoxOrient:'vertical'
        }}>
          {pickTitle(anime, lang)}
        </p>
      </div>
    </div>
  )
}

import { useNavigate } from 'react-router-dom'
import { formatScore, pickTitle } from '../../utils/formatters'
import { useLang } from '../../context/LanguageContext'

const scoreColor = (s) => s >= 75 ? '#30d158' : s >= 50 ? '#ff9f0a' : '#ff453a'

export default function AnimeCard({ anime, rank, watcherCount }) {
  const navigate = useNavigate()
  const { lang } = useLang()
  const { anilistId, titleRomaji, coverImageUrl, posterAccent, posterAccentRgb, averageScore, genres = [], format } = anime
  const go = () => navigate(`/anime/${anilistId}`, { state: { posterAccent, posterAccentRgb } })

  return (
    <div
      onClick={go}
      role="button"
      tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && go()}
      aria-label={pickTitle(anime, lang)}
      style={{
        position: 'relative', cursor: 'pointer', borderRadius: 12,
        overflow: 'hidden', background: '#1c1c1e',
        border: '1px solid #38383a',
        transition: 'transform 0.25s cubic-bezier(0.4,0,0.2,1), box-shadow 0.25s cubic-bezier(0.4,0,0.2,1)',
        aspectRatio: '3/4'
      }}
      onMouseEnter={e => {
        e.currentTarget.style.transform = 'translateY(-4px)'
        e.currentTarget.style.boxShadow = '0 8px 24px rgba(0,0,0,0.40)'
        e.currentTarget.querySelector('.card-overlay').style.opacity = '1'
      }}
      onMouseLeave={e => {
        e.currentTarget.style.transform = 'none'
        e.currentTarget.style.boxShadow = 'none'
        e.currentTarget.querySelector('.card-overlay').style.opacity = '0'
      }}
    >
      {/* Cover image */}
      <img src={coverImageUrl} alt={titleRomaji}
        style={{ width:'100%', height:'100%', objectFit:'cover', display:'block' }}
        onError={e => { e.target.style.background = '#2c2c2e' }}
      />

      {/* Rank badge */}
      {rank ? (
        <span style={{
          position:'absolute', top:8, left:8,
          color:'#0a84ff', fontSize:20, fontWeight:900,
          lineHeight:1, fontFamily:"'Sora',sans-serif",
          background:'rgba(0,0,0,0.65)', backdropFilter:'blur(8px)',
          WebkitBackdropFilter:'blur(8px)',
          padding:'4px 8px', borderRadius:6
        }}>#{rank}</span>
      ) : format && (
        <span style={{
          position:'absolute', top:8, left:8,
          background:'rgba(0,0,0,0.75)', backdropFilter:'blur(8px)',
          color:'rgba(235,235,245,0.60)', fontSize:10, fontWeight:700,
          padding:'3px 7px', borderRadius:5, letterSpacing:'0.5px'
        }}>{format}</span>
      )}

      {/* Score badge */}
      {averageScore && (
        <span style={{
          position:'absolute', top:8, right:8,
          background:'rgba(0,0,0,0.75)', backdropFilter:'blur(8px)',
          color: scoreColor(averageScore), fontSize:11, fontWeight:700,
          padding:'3px 7px', borderRadius:6,
          fontFamily:"'JetBrains Mono',monospace"
        }}>★ {formatScore(averageScore)}</span>
      )}

      {/* Watcher count badge */}
      {watcherCount > 0 && (
        <span style={{
          position:'absolute', bottom:8, left:8,
          background:'rgba(0,0,0,0.75)', backdropFilter:'blur(8px)',
          color:'#5ac8fa', fontSize:10, fontWeight:700,
          padding:'3px 7px', borderRadius:5
        }}>{watcherCount} 人</span>
      )}

      {/* Bottom gradient */}
      <div style={{
        position:'absolute', bottom:0, left:0, right:0,
        background:'linear-gradient(to top, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.55) 55%, transparent 100%)',
        padding:'32px 10px 10px'
      }}>
        {/* Genres — revealed on hover */}
        <div className="card-overlay" style={{
          opacity:0, transition:'opacity 0.25s',
          display:'flex', flexWrap:'wrap', gap:4, marginBottom:6
        }}>
          {genres.slice(0,2).map(g => (
            <span key={g} style={{
              fontSize:10, padding:'2px 7px', borderRadius:9999,
              background:'rgba(120,120,128,0.12)', color:'rgba(235,235,245,0.60)', fontWeight:500
            }}>{g}</span>
          ))}
        </div>
        {/* Title */}
        <p style={{
          fontFamily:"'Sora',sans-serif", fontSize:13, fontWeight:600,
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

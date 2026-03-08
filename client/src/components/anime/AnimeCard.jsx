import { useNavigate } from 'react-router-dom'
import { formatScore, pickTitle } from '../../utils/formatters'
import { useLang } from '../../context/LanguageContext'

const scoreColor = (s) => s >= 75 ? '#22c55e' : s >= 50 ? '#eab308' : '#ef4444'

export default function AnimeCard({ anime }) {
  const navigate = useNavigate()
  const { lang } = useLang()
  const { anilistId, titleRomaji, titleEnglish, coverImageUrl, averageScore, genres = [], format } = anime

  return (
    <div
      onClick={() => navigate(`/anime/${anilistId}`)}
      style={{
        position: 'relative', cursor: 'pointer', borderRadius: 12,
        overflow: 'hidden', background: '#111827',
        border: '1px solid rgba(148,163,184,0.08)',
        transition: 'transform 0.25s, border-color 0.25s, box-shadow 0.25s',
        aspectRatio: '2/3'
      }}
      onMouseEnter={e => {
        e.currentTarget.style.transform = 'translateY(-4px) scale(1.02)'
        e.currentTarget.style.borderColor = 'rgba(124,58,237,0.5)'
        e.currentTarget.style.boxShadow = '0 16px 40px rgba(124,58,237,0.25)'
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
        onError={e => { e.target.style.background = '#1a2235' }}
      />

      {/* Format badge */}
      {format && (
        <span style={{
          position:'absolute', top:8, left:8,
          background:'rgba(10,14,26,0.85)', backdropFilter:'blur(8px)',
          color:'#94a3b8', fontSize:10, fontWeight:700,
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

      {/* Hover overlay */}
      <div className="card-overlay" style={{
        position:'absolute', inset:0, opacity:0, transition:'opacity 0.25s',
        background:'linear-gradient(to top, rgba(10,14,26,0.97) 0%, rgba(10,14,26,0.5) 60%, transparent 100%)',
        display:'flex', flexDirection:'column', justifyContent:'flex-end', padding:12
      }}>
        <p style={{ fontFamily:"'Sora',sans-serif", fontSize:12, fontWeight:600, color:'#f1f5f9', marginBottom:6, lineHeight:1.3 }}>
          {pickTitle(anime, lang)}
        </p>
        <div style={{ display:'flex', flexWrap:'wrap', gap:4 }}>
          {genres.slice(0,2).map(g => (
            <span key={g} style={{
              fontSize:10, padding:'2px 7px', borderRadius:4,
              background:'rgba(124,58,237,0.3)', color:'#c4b5fd', fontWeight:500
            }}>{g}</span>
          ))}
        </div>
      </div>
    </div>
  )
}

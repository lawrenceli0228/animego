import { Link } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { useSubscriptions } from '../../hooks/useSubscription'

export default function ContinueWatching() {
  const { user } = useAuth()
  const { data: list, isLoading } = useSubscriptions('watching')

  if (!user || isLoading || !list?.length) return null

  return (
    <section style={{ marginTop: 40 }}>
      <div style={{ marginBottom: 16 }}>
        <p style={{ color: '#7c3aed', fontSize: 13, fontWeight: 600, letterSpacing: '2px', textTransform: 'uppercase', marginBottom: 8 }}>
          继续追番
        </p>
        <h2 style={{ fontSize: 'clamp(22px,3vw,32px)', background: 'linear-gradient(135deg,#f1f5f9,#94a3b8)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
          我的在追
        </h2>
      </div>

      {/* Horizontal scroll strip */}
      <div style={{
        display: 'flex', gap: 14, overflowX: 'auto', paddingBottom: 8,
        scrollbarWidth: 'thin', scrollbarColor: 'rgba(124,58,237,0.3) transparent'
      }}>
        {list.map(item => (
          <Link
            key={item.anilistId}
            to={`/anime/${item.anilistId}`}
            style={{
              flexShrink: 0, width: 130, textDecoration: 'none', color: 'inherit',
              borderRadius: 12, overflow: 'hidden',
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(148,163,184,0.08)',
              transition: 'transform 0.2s, border-color 0.2s'
            }}
            onMouseEnter={e => {
              e.currentTarget.style.transform = 'translateY(-4px)'
              e.currentTarget.style.borderColor = 'rgba(124,58,237,0.4)'
            }}
            onMouseLeave={e => {
              e.currentTarget.style.transform = 'translateY(0)'
              e.currentTarget.style.borderColor = 'rgba(148,163,184,0.08)'
            }}
          >
            {/* Cover */}
            <div style={{ position: 'relative' }}>
              <img
                src={item.coverImageUrl}
                alt={item.titleRomaji}
                style={{ width: '100%', aspectRatio: '3/4', objectFit: 'cover', display: 'block', background: '#1a2235' }}
                loading="lazy"
              />
              {/* Progress bar */}
              {item.episodes > 0 && (
                <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 3, background: 'rgba(0,0,0,0.5)' }}>
                  <div style={{
                    height: '100%',
                    width: `${Math.min(100, (item.currentEpisode / item.episodes) * 100)}%`,
                    background: 'linear-gradient(90deg,#7c3aed,#06b6d4)'
                  }} />
                </div>
              )}
              {/* Episode badge */}
              <div style={{
                position: 'absolute', top: 6, right: 6,
                background: 'rgba(10,14,26,0.75)', backdropFilter: 'blur(4px)',
                borderRadius: 6, padding: '2px 6px',
                fontSize: 11, fontWeight: 600, color: '#a78bfa'
              }}>
                {item.currentEpisode > 0
                  ? `${item.currentEpisode}${item.episodes > 0 ? `/${item.episodes}` : ''} 集`
                  : item.episodes > 0 ? `共 ${item.episodes} 集` : '追番中'}
              </div>
            </div>

            {/* Title */}
            <div style={{ padding: '8px 10px 10px' }}>
              <div style={{
                fontSize: 12, fontWeight: 600, color: '#f1f5f9',
                overflow: 'hidden', display: '-webkit-box',
                WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', lineHeight: 1.4
              }}>
                {item.titleEnglish || item.titleRomaji}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </section>
  )
}

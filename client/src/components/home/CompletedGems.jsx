import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useLang } from '../../context/LanguageContext'
import { useCompletedGems } from '../../hooks/useAnime'
import { pickTitle, formatScore } from '../../utils/formatters'

export default function CompletedGems() {
  const { t, lang } = useLang()
  const queryClient = useQueryClient()
  const { data, isLoading, isError } = useCompletedGems(10)

  if (isError) return null
  if (!isLoading && (!data || data.length === 0)) return null

  function handleRefresh() {
    queryClient.invalidateQueries({ queryKey: ['completedGems'] })
  }

  return (
    <section style={{ marginTop: 48 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <p style={{ color: '#0a84ff', fontSize: 13, fontWeight: 600, letterSpacing: '2px', textTransform: 'uppercase', marginBottom: 8 }}>
            {t('home.gemsLabel')}
          </p>
          <h2 style={{ fontSize: 'clamp(22px,3vw,32px)', color: '#ffffff' }}>
            {t('home.gemsTitle')}
          </h2>
        </div>
        {!isLoading && (
          <button
            onClick={handleRefresh}
            className="gems-refresh-btn"
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '8px 18px', borderRadius: 9999, fontSize: 13, fontWeight: 500,
              border: '1px solid #38383a', background: 'transparent',
              color: 'rgba(235,235,245,0.60)', cursor: 'pointer', transition: 'all 0.2s',
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = '#0a84ff'; e.currentTarget.style.color = '#0a84ff' }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = '#38383a'; e.currentTarget.style.color = 'rgba(235,235,245,0.60)' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/>
              <path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>
            </svg>
            {t('home.gemsRefresh')}
          </button>
        )}
      </div>

      {/* Grid — Bilibili "猜你喜欢" style */}
      <div className="gems-grid" style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(5, 1fr)',
        gap: 12,
      }}>
        {isLoading
          ? Array.from({ length: 10 }).map((_, i) => (
              <div key={i} style={{
                aspectRatio: '3/4', borderRadius: 10,
                background: 'linear-gradient(90deg, rgba(255,255,255,0.03) 25%, rgba(255,255,255,0.07) 50%, rgba(255,255,255,0.03) 75%)',
                backgroundSize: '200% 100%', animation: 'shimmer 1.4s ease-in-out infinite',
              }} />
            ))
          : data.map(item => (
              <Link
                key={item.anilistId}
                to={`/anime/${item.anilistId}`}
                className="gems-card"
                style={{
                  position: 'relative', display: 'block', borderRadius: 10, overflow: 'hidden',
                  textDecoration: 'none', color: 'inherit',
                }}
              >
                {/* Cover */}
                <img
                  src={item.coverImageUrl}
                  alt={item.titleRomaji}
                  style={{ width: '100%', aspectRatio: '3/4', objectFit: 'cover', display: 'block', background: '#2c2c2e' }}
                  loading="lazy"
                />

                {/* Score badge */}
                {item.averageScore > 0 && (
                  <div style={{
                    position: 'absolute', top: 8, right: 8,
                    background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)',
                    borderRadius: 6, padding: '2px 6px',
                    fontSize: 12, fontWeight: 700, color: '#ff9f0a',
                    fontFamily: "'JetBrains Mono',monospace",
                    fontVariantNumeric: 'tabular-nums',
                  }}>
                    {formatScore(item.averageScore)}
                  </div>
                )}

                {/* Episode count badge */}
                {item.episodes > 0 && (
                  <div style={{
                    position: 'absolute', top: 8, left: 8,
                    background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)',
                    borderRadius: 6, padding: '2px 6px',
                    fontSize: 11, fontWeight: 600, color: 'rgba(235,235,245,0.80)',
                  }}>
                    {item.episodes}{t('detail.epUnit')}
                  </div>
                )}

                {/* Bottom gradient overlay with title + genres */}
                <div style={{
                  position: 'absolute', bottom: 0, left: 0, right: 0,
                  background: 'linear-gradient(to top, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.6) 50%, transparent 100%)',
                  padding: '32px 10px 10px',
                }}>
                  <div style={{
                    fontFamily: "'Sora',sans-serif", fontSize: 13, fontWeight: 600, color: '#fff',
                    overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                    lineHeight: 1.4, marginBottom: 4,
                  }}>
                    {pickTitle(item, lang)}
                  </div>
                  <div style={{
                    fontSize: 11, color: 'rgba(235,235,245,0.50)',
                    overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
                  }}>
                    {(item.genres || []).slice(0, 3).join(' / ')}
                  </div>
                </div>
              </Link>
            ))
        }
      </div>

      <style>{`
        .gems-card { transition: transform 0.3s cubic-bezier(0.4,0,0.2,1), box-shadow 0.3s cubic-bezier(0.4,0,0.2,1); }
        .gems-card:hover { transform: translateY(-6px); box-shadow: 0 12px 28px rgba(0,0,0,0.50); }
        @media (max-width: 900px) {
          .gems-grid { grid-template-columns: repeat(3, 1fr) !important; }
        }
        @media (max-width: 600px) {
          .gems-grid { grid-template-columns: repeat(2, 1fr) !important; }
        }
      `}</style>
    </section>
  )
}

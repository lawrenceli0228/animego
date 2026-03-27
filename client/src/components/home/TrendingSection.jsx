import { useLang } from '../../context/LanguageContext'
import { useTrending } from '../../hooks/useAnime'
import AnimeCard from '../anime/AnimeCard'

function SkeletonCard() {
  return (
    <div style={{
      flexShrink: 0, width: 140, height: 210, borderRadius: 12,
      background: 'rgba(255,255,255,0.05)',
      border: '1px solid rgba(148,163,184,0.08)',
      animation: 'shimmer 1.4s ease-in-out infinite'
    }} />
  )
}

export default function TrendingSection() {
  const { t } = useLang()
  const { data, isLoading, isError } = useTrending(10)

  if (isError) return null
  if (!isLoading && (!data || data.length === 0)) return null

  return (
    <>
      <style>{`
        @keyframes shimmer {
          0%   { opacity: 0.5; }
          50%  { opacity: 1;   }
          100% { opacity: 0.5; }
        }
      `}</style>

      <section style={{ marginTop: 40 }}>
        <div style={{ marginBottom: 16 }}>
          <p style={{ color: '#0a84ff', fontSize: 13, fontWeight: 600, letterSpacing: '2px', textTransform: 'uppercase', marginBottom: 8 }}>
            {t('home.trendingLabel')}
          </p>
          <h2 style={{ fontSize: 'clamp(22px,3vw,32px)', background: 'linear-gradient(135deg,#ffffff,rgba(235,235,245,0.60))', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            {t('home.trendingTitle')}
          </h2>
        </div>

        <div style={{ display: 'flex', gap: 14, overflowX: 'auto', paddingBottom: 8, scrollbarWidth: 'thin', scrollbarColor: 'rgba(10,132,255,0.3) transparent' }}>
          {isLoading
            ? Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
            : data.map(item => (
                <div key={item.anilistId} style={{ flexShrink: 0, width: 140 }}>
                  <AnimeCard anime={item} rank={item.rank} watcherCount={item.watcherCount} />
                </div>
              ))
          }
        </div>
      </section>
    </>
  )
}

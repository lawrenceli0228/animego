import { useLang } from '../../context/LanguageContext'
import { useTrending } from '../../hooks/useAnime'
import AnimeCard from '../anime/AnimeCard'

export default function TrendingSection() {
  const { t } = useLang()
  const { data, isLoading, isError } = useTrending(10)

  if (isError) return null
  if (!isLoading && (!data || data.length === 0)) return null

  return (
    <section style={{ marginTop: 40 }}>
      <div style={{ marginBottom: 16 }}>
        <p style={{ color: '#0a84ff', fontSize: 13, fontWeight: 600, letterSpacing: '2px', textTransform: 'uppercase', marginBottom: 8 }}>
          {t('home.trendingLabel')}
        </p>
        <h2 style={{ fontSize: 'clamp(22px,3vw,32px)', color: '#ffffff' }}>
          {t('home.trendingTitle')}
        </h2>
      </div>

      {isLoading ? (
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
          gap: 16
        }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} style={{
              borderRadius: 12, aspectRatio: '3/4',
              background: 'linear-gradient(90deg, rgba(255,255,255,0.03) 25%, rgba(255,255,255,0.07) 50%, rgba(255,255,255,0.03) 75%)',
              backgroundSize: '200% 100%',
              border: '1px solid #38383a',
              animation: 'shimmer 1.4s ease-in-out infinite'
            }} />
          ))}
        </div>
      ) : (
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
          gap: 16, animation: 'fadeUp 0.4s ease both'
        }}>
          {data.map(item => (
            <AnimeCard key={item.anilistId} anime={item} rank={item.rank} watcherCount={item.watcherCount} />
          ))}
        </div>
      )}
    </section>
  )
}

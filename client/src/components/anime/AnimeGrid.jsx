import AnimeCard from './AnimeCard'
import LoadingSpinner from '../common/LoadingSpinner'
import { useLang } from '../../context/LanguageContext'

export default function AnimeGrid({ animeList, loading, error }) {
  const { t } = useLang()
  if (loading) return <LoadingSpinner />
  if (error) return (
    <div style={{ textAlign:'center', padding:'60px 0', color:'#ff453a' }}>
      {t('anime.loadError')}：{error.message}
    </div>
  )
  if (!animeList?.length) return (
    <div style={{ textAlign:'center', padding:'60px 0', color:'rgba(235,235,245,0.30)', fontFamily:"'Sora',sans-serif" }}>
      {t('anime.noAnime')}
    </div>
  )
  return (
    <>
      <div className="anime-grid-5col" style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(5, 1fr)',
        gap: 12,
        animation: 'fadeUp 0.4s ease both',
      }}>
        {animeList.map(a => <AnimeCard key={a.anilistId} anime={a} />)}
      </div>
      <style>{`
        @media (max-width: 900px) {
          .anime-grid-5col { grid-template-columns: repeat(3, 1fr) !important; }
        }
        @media (max-width: 600px) {
          .anime-grid-5col { grid-template-columns: repeat(2, 1fr) !important; }
        }
      `}</style>
    </>
  )
}

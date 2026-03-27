import AnimeCard from './AnimeCard'
import LoadingSpinner from '../common/LoadingSpinner'

export default function AnimeGrid({ animeList, loading, error }) {
  if (loading) return <LoadingSpinner />
  if (error) return (
    <div style={{ textAlign:'center', padding:'60px 0', color:'#ef4444' }}>
      加载失败：{error.message || '请稍后重试'}
    </div>
  )
  if (!animeList?.length) return (
    <div style={{ textAlign:'center', padding:'60px 0', color:'rgba(235,235,245,0.30)', fontFamily:"'Sora',sans-serif" }}>
      暂无番剧
    </div>
  )
  return (
    <div style={{
      display:'grid',
      gridTemplateColumns:'repeat(auto-fill, minmax(160px, 1fr))',
      gap:16, animation:'fadeUp 0.4s ease both'
    }}>
      {animeList.map(a => <AnimeCard key={a.anilistId} anime={a} />)}
    </div>
  )
}

import { useParams } from 'react-router-dom'
import { useAnimeDetail } from '../hooks/useAnime'
import AnimeDetailHero from '../components/anime/AnimeDetailHero'
import SubscriptionButton from '../components/subscription/SubscriptionButton'
import WatchersAvatarList from '../components/anime/WatchersAvatarList'
import EpisodeList from '../components/anime/EpisodeList'
import LoadingSpinner from '../components/common/LoadingSpinner'

export default function AnimeDetailPage() {
  const { id } = useParams()
  const { data: anime, isLoading, error } = useAnimeDetail(id)

  if (isLoading) return <LoadingSpinner />
  if (error) return (
    <div style={{ textAlign:'center', padding:'80px 0', color:'#ef4444' }}>
      加载失败：{error.message}
    </div>
  )
  if (!anime) return null

  return (
    <div>
      <AnimeDetailHero anime={anime} />
      <div className="container">
        <SubscriptionButton anilistId={anime.anilistId} episodes={anime.episodes} />
        <WatchersAvatarList anilistId={anime.anilistId} />
        <EpisodeList anime={anime} />
      </div>
    </div>
  )
}

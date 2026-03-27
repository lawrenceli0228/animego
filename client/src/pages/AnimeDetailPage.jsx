import { useParams } from 'react-router-dom'
import { useAnimeDetail } from '../hooks/useAnime'
import { pickTitle } from '../utils/formatters'
import { useLang } from '../context/LanguageContext'
import AnimeDetailHero from '../components/anime/AnimeDetailHero'
import SubscriptionButton from '../components/subscription/SubscriptionButton'
import WatchersAvatarList from '../components/anime/WatchersAvatarList'
import EpisodeList from '../components/anime/EpisodeList'
import LoadingSpinner from '../components/common/LoadingSpinner'

function ShareButton({ anime }) {
  const { t, lang } = useLang()
  const handle = async () => {
    const url = `${window.location.origin}/anime/${anime.anilistId}`
    const title = pickTitle(anime, lang)
    if (navigator.share) {
      try { await navigator.share({ title: `${title} — AnimeGo`, url }) }
      catch (_) {}
    } else {
      await navigator.clipboard.writeText(url)
      alert(t('detail.linkCopied'))
    }
  }
  return (
    <button
      onClick={handle}
      style={{
        marginLeft: 8, padding: '8px 14px', borderRadius: 8,
        border: '1px solid rgba(148,163,184,0.3)',
        background: 'transparent', color: 'rgba(235,235,245,0.60)',
        fontSize: 13, fontWeight: 600, cursor: 'pointer',
      }}
    >
      {t('social.share')}
    </button>
  )
}

export default function AnimeDetailPage() {
  const { id } = useParams()
  const { t } = useLang()
  const { data: anime, isLoading, error } = useAnimeDetail(id)

  if (isLoading) return <LoadingSpinner />
  if (error) return (
    <div style={{ textAlign:'center', padding:'80px 0', color:'#ef4444' }}>
      {t('anime.loadError')}：{error.message}
    </div>
  )
  if (!anime) return null

  return (
    <div>
      <AnimeDetailHero anime={anime} />
      <div className="container">
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4, marginTop: 16 }}>
          <SubscriptionButton anilistId={anime.anilistId} episodes={anime.episodes} />
          <ShareButton anime={anime} />
        </div>
        <WatchersAvatarList anilistId={anime.anilistId} />
        <EpisodeList anime={anime} />
      </div>
    </div>
  )
}

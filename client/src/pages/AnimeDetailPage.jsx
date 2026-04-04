import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { useAnimeDetail } from '../hooks/useAnime'
import { pickTitle } from '../utils/formatters'
import { useLang } from '../context/LanguageContext'
import AnimeDetailHero from '../components/anime/AnimeDetailHero'
import SubscriptionButton from '../components/subscription/SubscriptionButton'
import WatchersAvatarList from '../components/anime/WatchersAvatarList'
import EpisodeList from '../components/anime/EpisodeList'
import CharacterSection from '../components/anime/CharacterSection'
import StaffSection from '../components/anime/StaffSection'
import RecommendationSection from '../components/anime/RecommendationSection'
import TorrentModal from '../components/anime/TorrentModal'
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
        border: '1px solid rgba(84,84,88,0.65)',
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
  const [torrentOpen, setTorrentOpen] = useState(false)

  if (isLoading) return <LoadingSpinner />
  if (error) return (
    <div style={{ textAlign:'center', padding:'80px 0', color:'#ff453a' }}>
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
          {anime.episodes > 0 && (
            <button
              onClick={() => setTorrentOpen(true)}
              style={{
                marginLeft: 8, padding: '8px 14px', borderRadius: 8,
                border: '1px solid rgba(84,84,88,0.65)',
                background: 'transparent', color: 'rgba(235,235,245,0.60)',
                fontSize: 13, fontWeight: 600, cursor: 'pointer',
              }}
            >
              {t('torrent.download')}
            </button>
          )}
        </div>
        <WatchersAvatarList anilistId={anime.anilistId} />
        <CharacterSection characters={anime.characters} />
        <StaffSection staff={anime.staff} />
        <EpisodeList anime={anime} />
        <RecommendationSection recommendations={anime.recommendations} />
        {torrentOpen && <TorrentModal anime={anime} onClose={() => setTorrentOpen(false)} />}
      </div>
    </div>
  )
}

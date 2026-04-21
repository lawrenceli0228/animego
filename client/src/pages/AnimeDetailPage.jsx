import { useState, useEffect } from 'react'
import { useParams, useLocation } from 'react-router-dom'
import { useAnimeDetail } from '../hooks/useAnime'
import { pickTitle } from '../utils/formatters'
import { useLang } from '../context/LanguageContext'
import AnimeDetailHero from '../components/anime/AnimeDetailHero'
import SubscriptionButton from '../components/subscription/SubscriptionButton'
import WatchersAvatarList from '../components/anime/WatchersAvatarList'
import EpisodeList from '../components/anime/EpisodeList'
import CharacterSection from '../components/anime/CharacterSection'
import StaffSection from '../components/anime/StaffSection'
import RelationSection from '../components/anime/RelationSection'
import RecommendationSection from '../components/anime/RecommendationSection'
import TorrentModal from '../components/anime/TorrentModal'
import { DetailSkeleton } from '../components/common/Skeleton'

function OutlineButton({ onClick, children, style: extraStyle }) {
  const [hover, setHover] = useState(false)
  const [focus, setFocus] = useState(false)
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      style={{
        padding: '10px 18px', borderRadius: 8,
        border: `1px solid ${hover ? 'rgba(120,120,128,0.9)' : 'rgba(84,84,88,0.65)'}`,
        background: hover ? 'rgba(120,120,128,0.12)' : 'transparent',
        color: hover ? 'rgba(255,255,255,0.92)' : 'rgba(235,235,245,0.60)',
        fontSize: 13, fontWeight: 600, cursor: 'pointer',
        minHeight: 40,
        transition: 'background 150ms, border-color 150ms, color 150ms, transform 120ms, box-shadow 150ms',
        transform: hover ? 'translateY(-1px)' : 'none',
        boxShadow: focus ? '0 0 0 3px rgba(120,120,128,0.28)' : 'none',
        outline: 'none',
        ...extraStyle,
      }}
    >
      {children}
    </button>
  )
}

function PlayButton({ onClick }) {
  const { t } = useLang()
  const [hover, setHover] = useState(false)
  const [focus, setFocus] = useState(false)
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      aria-label={t('detail.openPlayerAria')}
      style={{
        padding: '10px 18px', borderRadius: 8,
        border: 'none',
        background: hover ? '#3395ff' : '#0a84ff',
        color: '#fff', fontSize: 13, fontWeight: 600,
        cursor: 'pointer', minHeight: 40,
        transition: 'background 150ms, transform 120ms, box-shadow 150ms',
        transform: hover ? 'translateY(-1px)' : 'none',
        boxShadow: focus
          ? '0 0 0 3px rgba(10,132,255,0.45)'
          : hover ? '0 2px 8px rgba(10,132,255,0.35)' : 'none',
        outline: 'none',
      }}
    >
      {t('detail.openPlayer')}
    </button>
  )
}

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
  return <OutlineButton onClick={handle}>{t('social.share')}</OutlineButton>
}

export default function AnimeDetailPage() {
  const { id } = useParams()
  const location = useLocation()
  const { t, lang } = useLang()
  const { data: anime, isLoading, error } = useAnimeDetail(id)
  const [torrentOpen, setTorrentOpen] = useState(false)

  useEffect(() => {
    if (anime) document.title = `${pickTitle(anime, lang)} — AnimeGo`
    return () => { document.title = 'AnimeGo' }
  }, [anime, lang])

  if (isLoading) return <DetailSkeleton posterAccent={location.state?.posterAccent} posterAccentRgb={location.state?.posterAccentRgb} />
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
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginTop: 16 }}>
          <SubscriptionButton anilistId={anime.anilistId} episodes={anime.episodes} />
          <ShareButton anime={anime} />
          {anime.episodes > 0 && (
            <>
              <OutlineButton onClick={() => setTorrentOpen(true)}>
                {t('torrent.download')}
              </OutlineButton>
              <PlayButton onClick={() => window.open('/player', '_blank', 'noopener,noreferrer')} />
            </>
          )}
        </div>
        <WatchersAvatarList anilistId={anime.anilistId} />
        <RelationSection relations={anime.relations} />
        <CharacterSection characters={anime.characters} />
        <StaffSection staff={anime.staff} />
        <EpisodeList anime={anime} />
        <RecommendationSection recommendations={anime.recommendations} />
        {torrentOpen && <TorrentModal anime={anime} onClose={() => setTorrentOpen(false)} />}
      </div>
    </div>
  )
}

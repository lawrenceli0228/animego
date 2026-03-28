import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useAuth } from '../context/AuthContext'
import { useLang } from '../context/LanguageContext'
import { useUserProfile } from '../hooks/useSocial'
import FollowButton from '../components/social/FollowButton'
import AnimeCard from '../components/anime/AnimeCard'
import LoadingSpinner from '../components/common/LoadingSpinner'

const STATUS_TABS = ['watching', 'completed', 'plan_to_watch', 'dropped']
const PAGE_SIZE = 12

function ShareButton({ username }) {
  const { t, lang } = useLang()
  const url = `${window.location.origin}/u/${username}`
  const handle = async () => {
    if (navigator.share) {
      try { await navigator.share({ title: `${username} 的追番列表 — AnimeGo`, url }) }
      catch (_) { /* user cancelled */ }
    } else {
      try {
        await navigator.clipboard.writeText(url)
        toast(t('detail.linkCopied'))
      } catch (_) {
        toast.error(t('detail.linkCopyFailed'))
      }
    }
  }
  return (
    <button
      onClick={handle}
      style={{
        padding: '8px 14px', borderRadius: 8,
        border: '1px solid rgba(148,163,184,0.3)',
        background: 'transparent', color: 'rgba(235,235,245,0.60)',
        fontSize: 13, fontWeight: 600, cursor: 'pointer',
      }}
    >
      {t('social.share')}
    </button>
  )
}

export default function UserProfilePage() {
  const { username } = useParams()
  const { user: me } = useAuth()
  const { t, lang } = useLang()
  const navigate = useNavigate()

  const { data: profile, isLoading, isError } = useUserProfile(username)
  const [expanded, setExpanded] = useState({})
  // Reset expand state when navigating to a different user's profile
  useEffect(() => { setExpanded({}) }, [username])

  if (isLoading) return (
    <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 80 }}>
      <LoadingSpinner />
    </div>
  )

  if (isError || !profile) return (
    <div style={{ textAlign: 'center', paddingTop: 80, color: 'rgba(235,235,245,0.60)' }}>
      {t('social.userNotFound')}
    </div>
  )

  const isSelf = me?.username === username

  // Group watching list by status
  const byStatus = STATUS_TABS.reduce((acc, s) => {
    acc[s] = (profile.watching || []).filter(a => a.subscriptionStatus === s)
    return acc
  }, {})

  const statusLabels = {
    watching:      t('sub.watching'),
    completed:     t('sub.completed'),
    plan_to_watch: t('sub.planToWatch'),
    dropped:       t('sub.dropped'),
  }

  return (
    <div className="container" style={{ paddingTop: 40, paddingBottom: 60 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 32, flexWrap: 'wrap' }}>
        {/* Avatar */}
        <div style={{
          width: 64, height: 64, borderRadius: '50%',
          background: 'linear-gradient(135deg,#0a84ff,#5ac8fa)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 26, fontWeight: 800, color: '#fff', flexShrink: 0,
          textTransform: 'uppercase',
        }}>
          {username[0]}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ fontSize: 'clamp(20px,3vw,30px)', color: '#ffffff', fontWeight: 800, marginBottom: 4 }}>
            {username}
          </h1>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <button
              onClick={() => navigate(`/u/${username}/followers`)}
              style={{ background: 'none', border: 'none', color: 'rgba(235,235,245,0.60)', fontSize: 13, cursor: 'pointer', padding: 0 }}
            >
              <strong style={{ color: '#ffffff' }}>{profile.followerCount}</strong>
              {' '}{t('social.followers')}
            </button>
            <button
              onClick={() => navigate(`/u/${username}/following`)}
              style={{ background: 'none', border: 'none', color: 'rgba(235,235,245,0.60)', fontSize: 13, cursor: 'pointer', padding: 0 }}
            >
              <strong style={{ color: '#ffffff' }}>{profile.followingCount}</strong>
              {' '}{t('social.following')}
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <ShareButton username={username} />
          <FollowButton
            username={username}
            isFollowing={profile.isFollowing}
            isSelf={isSelf}
          />
        </div>
      </div>

      {/* Tabs by status */}
      {STATUS_TABS.map(status => {
        const list = byStatus[status]
        if (list.length === 0) return null
        const isExpanded = expanded[status]
        const shown = isExpanded ? list : list.slice(0, PAGE_SIZE)
        const hasMore = list.length > PAGE_SIZE
        return (
          <section key={status} style={{ marginBottom: 40 }}>
            <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
              <h2 style={{ fontSize: 16, fontWeight: 700, color: '#ffffff' }}>
                {statusLabels[status]}
              </h2>
              <span style={{
                fontSize: 12, color: '#0a84ff', background: 'rgba(10,132,255,0.15)',
                padding: '2px 8px', borderRadius: 99, fontWeight: 600,
              }}>
                {list.length}
              </span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              {shown.map(anime => (
                <div key={anime.anilistId} style={{ width: 120 }}>
                  <AnimeCard anime={anime} />
                </div>
              ))}
            </div>
            {hasMore && (
              <button
                onClick={() => setExpanded(prev => ({ ...prev, [status]: !isExpanded }))}
                style={{
                  marginTop: 12, padding: '8px 20px', borderRadius: 8,
                  border: '1px solid rgba(148,163,184,0.2)',
                  background: 'transparent', color: 'rgba(235,235,245,0.60)',
                  fontSize: 13, fontWeight: 600, cursor: 'pointer',
                }}
              >
                {isExpanded
                  ? (lang === 'zh' ? '收起' : 'Show Less')
                  : (lang === 'zh' ? `显示更多 (${list.length - PAGE_SIZE})` : `Show More (${list.length - PAGE_SIZE})`)
                }
              </button>
            )}
          </section>
        )
      })}

      {(profile.watching || []).length === 0 && (
        <p style={{ color: '#475569', textAlign: 'center', paddingTop: 40 }}>
          {t('social.emptyList')}
        </p>
      )}
    </div>
  )
}

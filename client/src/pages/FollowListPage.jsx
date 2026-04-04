import { useParams, useNavigate } from 'react-router-dom'
import { useLang } from '../context/LanguageContext'
import { useFollowList } from '../hooks/useSocial'
import LoadingSpinner from '../components/common/LoadingSpinner'

export default function FollowListPage({ type }) {
  const { username } = useParams()
  const { t } = useLang()
  const navigate = useNavigate()
  const { data, isLoading, isError } = useFollowList(username, type)

  const title = type === 'followers' ? t('social.followers') : t('social.following')
  const users = data?.data ?? []

  return (
    <div className="container" style={{ paddingTop: 40, paddingBottom: 60 }}>
      {/* Back + title */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 28 }}>
        <button
          onClick={() => navigate(`/u/${username}`)}
          style={{ background: 'none', border: 'none', color: '#0a84ff', cursor: 'pointer', fontSize: 14, fontWeight: 600, padding: 0 }}
        >
          ← {username}
        </button>
        <span style={{ color: 'rgba(84,84,88,0.65)' }}>/</span>
        <h1 style={{ fontSize: 18, fontWeight: 700, color: '#ffffff', margin: 0 }}>
          {title}
          {data?.total > 0 && (
            <span style={{ marginLeft: 8, fontSize: 13, color: '#0a84ff', fontWeight: 600 }}>
              {data.total}
            </span>
          )}
        </h1>
      </div>

      {isLoading && (
        <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 60 }}>
          <LoadingSpinner />
        </div>
      )}

      {isError && (
        <p style={{ color: 'rgba(235,235,245,0.40)', textAlign: 'center', paddingTop: 40 }}>
          {t('social.userNotFound')}
        </p>
      )}

      {!isLoading && !isError && users.length === 0 && (
        <p style={{ color: 'rgba(235,235,245,0.30)', textAlign: 'center', paddingTop: 40 }}>
          —
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 480 }}>
        {users.map(u => (
          <button
            key={u.username}
            onClick={() => navigate(`/u/${u.username}`)}
            style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '10px 14px', borderRadius: 10,
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid #38383a',
              cursor: 'pointer', textAlign: 'left', transition: 'all 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(10,132,255,0.4)'; e.currentTarget.style.background = 'rgba(10,132,255,0.06)' }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = '#38383a'; e.currentTarget.style.background = 'rgba(255,255,255,0.03)' }}
          >
            <div style={{
              width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
              background: '#0a84ff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 15, fontWeight: 800, color: '#fff', textTransform: 'uppercase',
            }}>
              {u.username[0]}
            </div>
            <span style={{ fontSize: 14, fontWeight: 600, color: '#ffffff' }}>
              {u.username}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

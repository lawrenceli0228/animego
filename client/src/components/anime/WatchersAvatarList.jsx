import { useNavigate } from 'react-router-dom'
import { useLang } from '../../context/LanguageContext'
import { useWatchers } from '../../hooks/useAnime'

const COLORS = ['#7c3aed', '#06b6d4', '#10b981', '#f59e0b', '#ec4899', '#6366f1']

function avatarColor(username) {
  return COLORS[username.charCodeAt(0) % COLORS.length]
}

export default function WatchersAvatarList({ anilistId }) {
  const { t, lang } = useLang()
  const navigate = useNavigate()
  const { data, isLoading } = useWatchers(anilistId, 5)

  if (isLoading || !data || data.total === 0) return null

  const { data: watchers, total } = data
  const more = total - watchers.length

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
      {/* Avatar circles */}
      <div style={{ display: 'flex' }}>
        {watchers.map((w, i) => (
          <div
            key={w.username}
            title={w.username}
            aria-label={w.username}
            role="button"
            tabIndex={0}
            onClick={() => navigate(`/u/${w.username}`)}
            onKeyDown={e => e.key === 'Enter' && navigate(`/u/${w.username}`)}
            style={{
              width: 28, height: 28, borderRadius: '50%',
              background: avatarColor(w.username),
              border: '2px solid #0a0e1a',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 11, fontWeight: 700, color: '#fff', textTransform: 'uppercase',
              marginRight: i < watchers.length - 1 ? -8 : 0,
              zIndex: watchers.length - i,
              position: 'relative', flexShrink: 0, cursor: 'pointer',
            }}
          >
            {w.username[0]}
          </div>
        ))}
      </div>

      {/* Count text */}
      <span style={{ fontSize: 12, color: '#94a3b8', marginLeft: watchers.length > 0 ? 10 : 0 }}>
        {`${total} ${t('anime.watchers')}`}
        {more > 0 && (
          <span style={{ color: '#7c3aed', marginLeft: 4 }}>
            {lang === 'zh' ? `（${t('anime.watchersMore')} ${more} 人）` : `(${t('anime.watchersMore')}${more} more)`}
          </span>
        )}
      </span>
    </div>
  )
}

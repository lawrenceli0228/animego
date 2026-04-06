import { useNavigate } from 'react-router-dom'
import { useFeed } from '../../hooks/useSocial'
import { useLang } from '../../context/LanguageContext'
import { useAuth } from '../../context/AuthContext'

function timeAgo(date, lang) {
  const diff = Math.floor((Date.now() - new Date(date)) / 1000)
  if (diff < 60)  return lang === 'zh' ? '刚刚' : 'just now'
  if (diff < 3600) {
    const m = Math.floor(diff / 60)
    return lang === 'zh' ? `${m} 分钟前` : `${m}m ago`
  }
  if (diff < 86400) {
    const h = Math.floor(diff / 3600)
    return lang === 'zh' ? `${h} 小时前` : `${h}h ago`
  }
  const d = Math.floor(diff / 86400)
  return lang === 'zh' ? `${d} 天前` : `${d}d ago`
}

export default function ActivityFeed() {
  const { user } = useAuth()
  const { data, isLoading, isError, hasNextPage, fetchNextPage, isFetchingNextPage } = useFeed()
  const navigate = useNavigate()
  const { t, lang } = useLang()

  const items = data?.pages?.flatMap(p => p.data) ?? []

  if (!user) return null
  if (isError) return null
  if (!isLoading && items.length === 0) return (
    <section style={{ marginTop: 40 }}>
      <p style={{ color: 'rgba(235,235,245,0.30)', fontSize: 13, textAlign: 'center', padding: '16px 0' }}>
        {t('social.noActivity')}
      </p>
    </section>
  )

  return (
    <section style={{ marginTop: 40 }}>
      <div style={{ marginBottom: 16 }}>
        <p style={{ color: '#0a84ff', fontSize: 13, fontWeight: 600, letterSpacing: '2px', textTransform: 'uppercase', marginBottom: 8 }}>
          {t('social.feedLabel')}
        </p>
        <h2 style={{ fontSize: 'clamp(20px,2.5vw,28px)', color: '#ffffff' }}>
          {t('social.feedTitle')}
        </h2>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {isLoading
          ? Array.from({ length: 4 }).map((_, i) => (
              <div key={i} style={{ height: 64, borderRadius: 10, background: 'rgba(255,255,255,0.05)', animation: 'shimmer 1.4s ease-in-out infinite' }} />
            ))
          : items.map((item) => (
              <div
                key={`${item.username}:${item.anilistId}:${item.lastWatchedAt}`}
                onClick={() => navigate(`/anime/${item.anilistId}`)}
                role="button"
                tabIndex={0}
                onKeyDown={e => e.key === 'Enter' && navigate(`/anime/${item.anilistId}`)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '10px 14px', borderRadius: 10,
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid #38383a',
                  cursor: 'pointer', transition: 'background 0.2s',
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.07)'}
                onMouseLeave={e => e.currentTarget.style.background = 'rgba(255,255,255,0.04)'}
              >
                {item.coverImageUrl && (
                  <img
                    src={item.coverImageUrl}
                    alt=""
                    style={{ width: 36, height: 52, borderRadius: 4, objectFit: 'cover', flexShrink: 0 }}
                  />
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span
                    onClick={e => { e.stopPropagation(); navigate(`/u/${item.username}`) }}
                    style={{ color: '#0a84ff', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}
                  >
                    {item.username}
                  </span>
                  <span style={{ color: 'rgba(235,235,245,0.60)', fontSize: 13 }}>
                    {' '}{t(`social.action_${item.status}`)}{' '}
                  </span>
                  <span style={{ color: '#ffffff', fontSize: 13, fontWeight: 500 }}>
                    {lang === 'zh' && item.titleChinese ? item.titleChinese : item.title}
                  </span>
                  {item.episode > 0 && (
                    <span style={{ color: 'rgba(235,235,245,0.60)', fontSize: 12 }}>
                      {' '}· Ep {item.episode}
                    </span>
                  )}
                </div>
                <span style={{ color: 'rgba(235,235,245,0.30)', fontSize: 11, flexShrink: 0 }}>
                  {timeAgo(item.lastWatchedAt, lang)}
                </span>
              </div>
            ))
        }
      </div>

      {hasNextPage && (
        <button
          onClick={() => fetchNextPage()}
          disabled={isFetchingNextPage}
          style={{
            display: 'block', margin: '16px auto 0', padding: '8px 24px',
            borderRadius: 8, border: '1px solid #38383a', background: 'transparent',
            color: 'rgba(235,235,245,0.60)', fontSize: 13, fontWeight: 500,
            cursor: isFetchingNextPage ? 'wait' : 'pointer', transition: 'background 0.2s',
          }}
          onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
        >
          {isFetchingNextPage ? '...' : t('social.loadMore')}
        </button>
      )}
    </section>
  )
}

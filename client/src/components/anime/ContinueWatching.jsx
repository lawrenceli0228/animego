import { Link } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { useLang } from '../../context/LanguageContext'
import { useSubscriptions } from '../../hooks/useSubscription'
import { pickTitle } from '../../utils/formatters'

export default function ContinueWatching() {
  const { user } = useAuth()
  const { t, lang } = useLang()
  const { data: list, isLoading } = useSubscriptions('watching')

  if (!user || isLoading || !list?.length) return null

  return (
    <section style={{ marginTop: 40 }}>
      <div style={{ marginBottom: 16 }}>
        <p style={{ color: '#0a84ff', fontSize: 13, fontWeight: 600, letterSpacing: '2px', textTransform: 'uppercase', marginBottom: 8 }}>
          {t('home.continueLabel')}
        </p>
        <h2 style={{ fontSize: 'clamp(22px,3vw,32px)', color: '#ffffff' }}>
          {t('home.watchingTitle')}
        </h2>
      </div>

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
        gap: 16, animation: 'fadeUp 0.4s ease both'
      }}>
        {list.map(item => (
          <Link key={item.anilistId} to={`/anime/${item.anilistId}`}
            style={{ textDecoration: 'none', color: 'inherit', borderRadius: 12, overflow: 'hidden', transition: 'transform 0.25s cubic-bezier(0.4,0,0.2,1), box-shadow 0.25s cubic-bezier(0.4,0,0.2,1)' }}
            onMouseEnter={e => { e.currentTarget.style.transform='translateY(-4px)'; e.currentTarget.style.boxShadow='0 8px 24px rgba(0,0,0,0.40)' }}
            onMouseLeave={e => { e.currentTarget.style.transform='translateY(0)'; e.currentTarget.style.boxShadow='none' }}
          >
            <div style={{ position: 'relative' }}>
              <img src={item.coverImageUrl} alt={item.titleRomaji}
                style={{ width: '100%', aspectRatio: '3/4', objectFit: 'cover', display: 'block', background: '#2c2c2e' }}
                loading="lazy"
              />
              <div style={{ position: 'absolute', top: 6, right: 6, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)', borderRadius: 6, padding: '2px 6px', fontSize: 11, fontWeight: 600, color: '#0a84ff' }}>
                {item.currentEpisode > 0
                  ? `${item.currentEpisode}${item.episodes > 0 ? `/${item.episodes}` : ''} ${t('detail.epUnit')}`
                  : item.episodes > 0 ? `${item.episodes} ${t('detail.epUnit')}` : t('sub.watching')}
              </div>
              <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '24px 8px 6px', background: 'linear-gradient(to top, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.4) 60%, transparent 100%)' }}>
                <div style={{ fontFamily: "'Sora',sans-serif", fontSize: 12, fontWeight: 600, color: '#ffffff', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', lineHeight: 1.35, marginBottom: 5, textShadow: '0 1px 3px rgba(0,0,0,0.5)' }}>
                  {pickTitle(item, lang)}
                </div>
                {item.episodes > 0 && (
                  <div style={{ height: 3, borderRadius: 1.5, background: 'rgba(255,255,255,0.15)' }}>
                    <div style={{ height: '100%', borderRadius: 1.5, width: `${Math.min(100, (item.currentEpisode / item.episodes) * 100)}%`, background: '#0a84ff' }} />
                  </div>
                )}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </section>
  )
}

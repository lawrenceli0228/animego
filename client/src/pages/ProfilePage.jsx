import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useLang } from '../context/LanguageContext'
import { useSubscriptions } from '../hooks/useSubscription'
import { STATUS_OPTIONS } from '../utils/constants'
import { pickTitle, formatScore } from '../utils/formatters'
import { ProfileListSkeleton } from '../components/common/Skeleton'
import AnimeStats from '../components/profile/AnimeStats'

const SORT_OPTIONS = [
  { value: 'updatedAt', zh: '最近更新', en: 'Recently Updated' },
  { value: 'score',     zh: '我的评分', en: 'My Score' },
  { value: 'title',     zh: '标题',     en: 'Title' },
  { value: 'avgScore',  zh: '均分',     en: 'Average Score' },
]

const scoreColor = (s) => s >= 75 ? '#30d158' : s >= 50 ? '#ff9f0a' : '#ff453a'

export default function ProfilePage() {
  const { user } = useAuth()
  const { t, lang } = useLang()
  const navigate = useNavigate()
  const [activeStatus, setActiveStatus] = useState('watching')
  const [sortBy, setSortBy] = useState('updatedAt')
  const [search, setSearch] = useState('')
  const { data: subs, isLoading } = useSubscriptions(activeStatus)

  const statusLabels = {
    watching: t('sub.watching'), completed: t('sub.completed'),
    plan_to_watch: t('sub.planToWatch'), dropped: t('sub.dropped'),
  }

  const filtered = useMemo(() => {
    if (!subs) return []
    let list = subs
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(s =>
        (s.titleChinese || '').toLowerCase().includes(q) ||
        (s.titleRomaji || '').toLowerCase().includes(q) ||
        (s.titleEnglish || '').toLowerCase().includes(q) ||
        (s.titleNative || '').toLowerCase().includes(q)
      )
    }
    const sorted = [...list]
    switch (sortBy) {
      case 'score':
        sorted.sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
        break
      case 'title':
        sorted.sort((a, b) => pickTitle(a, lang).localeCompare(pickTitle(b, lang)))
        break
      case 'avgScore':
        sorted.sort((a, b) => (b.averageScore ?? 0) - (a.averageScore ?? 0))
        break
      default:
        break // already sorted by updatedAt from server
    }
    return sorted
  }, [subs, search, sortBy, lang])

  const counts = useMemo(() => {
    if (!subs) return {}
    return { [activeStatus]: subs.length }
  }, [subs, activeStatus])

  return (
    <div className="container" style={{ paddingTop: 40, paddingBottom: 60 }}>
      <div style={{ marginBottom: 36 }}>
        <p style={{ color: '#0a84ff', fontSize: 13, fontWeight: 600, letterSpacing: '2px',
          textTransform: 'uppercase', marginBottom: 8 }}>{t('profile.label')}</p>
        <h1 style={{ fontSize: 'clamp(24px,3.5vw,38px)', color: '#ffffff' }}>
          {user?.username}{t('profile.titleSuffix')}
        </h1>
      </div>

      <AnimeStats />

      {/* Status tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, background: '#1c1c1e',
        borderRadius: 12, padding: 5, width: 'fit-content', border: '1px solid #38383a' }}>
        {STATUS_OPTIONS.map(opt => (
          <button key={opt.value} onClick={() => setActiveStatus(opt.value)}
            style={{
              padding: '8px 20px', borderRadius: 8, fontSize: 14, fontWeight: 600,
              cursor: 'pointer', border: 'none', transition: 'all 0.2s',
              fontFamily: "'Sora',sans-serif",
              background: activeStatus === opt.value ? `linear-gradient(135deg,${opt.color}33,${opt.color}22)` : 'transparent',
              color: activeStatus === opt.value ? opt.color : 'rgba(235,235,245,0.30)',
              boxShadow: activeStatus === opt.value ? `0 2px 12px ${opt.color}30` : 'none',
              borderBottom: activeStatus === opt.value ? `2px solid ${opt.color}` : '2px solid transparent',
            }}>
            {statusLabels[opt.value]}
            {counts[opt.value] != null && (
              <span style={{ marginLeft: 6, fontSize: 11, opacity: 0.6 }}>{counts[opt.value]}</span>
            )}
          </button>
        ))}
      </div>

      {/* Sort + Search bar */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 24, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          type="text" value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={lang === 'zh' ? '搜索我的列表...' : 'Search my list...'}
          style={{
            padding: '8px 14px', borderRadius: 8, border: '1px solid #38383a',
            background: '#1c1c1e', color: '#fff', fontSize: 13, flex: '1 1 200px',
            minWidth: 180, outline: 'none',
          }}
        />
        <select value={sortBy} onChange={e => setSortBy(e.target.value)}
          style={{
            padding: '8px 14px', borderRadius: 8, border: '1px solid #38383a',
            background: '#1c1c1e', color: 'rgba(235,235,245,0.60)', fontSize: 13,
            cursor: 'pointer', outline: 'none',
          }}>
          {SORT_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>{lang === 'zh' ? o.zh : o.en}</option>
          ))}
        </select>
      </div>

      {/* Anime list */}
      {isLoading ? (
        <ProfileListSkeleton />
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'rgba(235,235,245,0.30)',
          fontFamily: "'Sora',sans-serif", fontSize: 15 }}>
          {search ? (lang === 'zh' ? '无匹配结果' : 'No matches') : (
            <>{t('profile.noAnime')} 「{statusLabels[activeStatus]}」 {t('profile.noAnimeSuffix')}</>
          )}
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
          gap: 12,
        }}>
          {filtered.map(item => (
            <div
              key={item.anilistId}
              onClick={() => navigate(`/anime/${item.anilistId}`)}
              role="button" tabIndex={0}
              onKeyDown={e => e.key === 'Enter' && navigate(`/anime/${item.anilistId}`)}
              style={{
                display: 'flex', gap: 12, padding: 12, borderRadius: 10,
                background: '#1c1c1e', border: '1px solid #38383a',
                cursor: 'pointer', transition: 'background 0.2s',
              }}
              onMouseEnter={e => e.currentTarget.style.background = '#2c2c2e'}
              onMouseLeave={e => e.currentTarget.style.background = '#1c1c1e'}
            >
              <img
                src={item.coverImageUrl} alt={pickTitle(item, lang)}
                style={{ width: 56, height: 80, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }}
              />
              <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                <p style={{
                  fontFamily: "'Sora',sans-serif", fontSize: 14, fontWeight: 600,
                  color: '#fff', margin: 0, marginBottom: 4, lineHeight: 1.35,
                  overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
                }}>{pickTitle(item, lang)}</p>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  {item.averageScore && (
                    <span style={{
                      fontSize: 11, fontWeight: 700, color: scoreColor(item.averageScore),
                      fontFamily: "'JetBrains Mono',monospace",
                    }}>★ {formatScore(item.averageScore)}</span>
                  )}
                  {item.score && (
                    <span style={{
                      fontSize: 11, fontWeight: 700, color: '#0a84ff',
                      fontFamily: "'JetBrains Mono',monospace",
                    }}>{lang === 'zh' ? '我' : 'Me'}: {item.score}/10</span>
                  )}
                  {item.currentEpisode > 0 && (
                    <span style={{ fontSize: 11, color: 'rgba(235,235,245,0.40)' }}>
                      {lang === 'zh' ? `看到第 ${item.currentEpisode} 集` : `Ep ${item.currentEpisode}`}
                      {item.episodes ? ` / ${item.episodes}` : ''}
                    </span>
                  )}
                  {item.format && (
                    <span style={{
                      fontSize: 10, color: 'rgba(235,235,245,0.30)',
                      padding: '1px 6px', borderRadius: 4, background: 'rgba(120,120,128,0.12)',
                    }}>{item.format}</span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useWeeklySchedule } from '../../hooks/useAnime'
import { useLang } from '../../context/LanguageContext'
import { pickTitle } from '../../utils/formatters'

const DAY_ZH = { 0: '周日', 1: '周一', 2: '周二', 3: '周三', 4: '周四', 5: '周五', 6: '周六' }
const DAY_EN = { 0: 'Sun', 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat' }

function localToday() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function formatTime(unixSec) {
  return new Date(unixSec * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

const s = {
  section: { marginTop: 56 },
  header: { marginBottom: 20 },
  label: { color: '#0a84ff', fontSize: 13, fontWeight: 600, letterSpacing: '2px', textTransform: 'uppercase', marginBottom: 8 },
  title: { fontSize: 'clamp(22px,3vw,32px)', color: '#ffffff' },
  tabs: { display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 8, marginBottom: 24, scrollbarWidth: 'none' },
  tab: (active, isToday) => ({
    padding: '6px 18px', minHeight: 44, borderRadius: 20, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: 'none', whiteSpace: 'nowrap', transition: 'all 0.2s',
    background: active ? '#0a84ff' : isToday ? 'rgba(10,132,255,0.12)' : 'rgba(120,120,128,0.12)',
    color: active ? '#fff' : isToday ? '#0a84ff' : 'rgba(235,235,245,0.60)',
    outline: 'none'
  }),
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 14 },
  card: { display: 'flex', flexDirection: 'column', borderRadius: 12, background: '#1c1c1e', border: '1px solid #38383a', overflow: 'hidden', textDecoration: 'none', color: 'inherit', transition: 'transform 0.25s cubic-bezier(0.4,0,0.2,1), box-shadow 0.25s cubic-bezier(0.4,0,0.2,1)' },
  cover: { width: '100%', aspectRatio: '3/4', objectFit: 'cover', display: 'block', background: '#2c2c2e' },
  cardBody: { padding: '8px 10px 10px' },
  titleText: { fontSize: 13, fontWeight: 600, color: '#ffffff', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', lineHeight: 1.4, marginBottom: 6 },
  meta: { display: 'flex', flexDirection: 'column', gap: 4 },
  ep: { fontSize: 11, color: '#0a84ff', fontWeight: 600, background: 'rgba(10,132,255,0.15)', padding: '2px 7px', borderRadius: 4, alignSelf: 'flex-start' },
  timeScore: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  time: { fontSize: 11, color: 'rgba(235,235,245,0.30)' },
  score: { fontSize: 11, color: '#ff9f0a', fontWeight: 600, fontFamily: "'JetBrains Mono',monospace" },
  empty: { color: 'rgba(235,235,245,0.30)', fontSize: 14, padding: '32px 0', textAlign: 'center' }
}

export default function WeeklySchedule() {
  const { data, isLoading } = useWeeklySchedule()
  const { lang, t } = useLang()
  const today = localToday()
  const [selected, setSelected] = useState(null)

  if (isLoading) return null

  const days    = data ? Object.keys(data.groups).sort() : []
  const active  = selected ?? today
  const activeDay = days.includes(active) ? active : days[0]
  const items   = data?.groups[activeDay] ?? []

  const DAY_MAP = lang === 'zh' ? DAY_ZH : DAY_EN

  function formatDayLabel(dateStr) {
    if (dateStr === today) return t('home.today')
    const d = new Date(dateStr + 'T00:00:00')
    return DAY_MAP[d.getDay()]
  }

  return (
    <section style={s.section}>
      <div style={s.header}>
        <p style={s.label}>{t('home.scheduleLabel')}</p>
        <h2 style={s.title}>{t('home.thisWeek')}</h2>
      </div>

      <div style={s.tabs}>
        {days.map(d => (
          <button key={d} style={s.tab(d === activeDay, d === today)} onClick={() => setSelected(d)}>
            {formatDayLabel(d)}
            <span style={{ marginLeft: 4, opacity: 0.7, fontSize: 11 }}>{data.groups[d]?.length ?? 0}</span>
          </button>
        ))}
      </div>

      {items.length === 0
        ? <p style={s.empty}>{t('home.noUpdates')}</p>
        : (
          <div style={s.grid}>
            {items.map(item => (
              <Link key={item.scheduleId} to={`/anime/${item.anilistId}`} style={s.card}
                onMouseEnter={e => { e.currentTarget.style.transform='translateY(-4px)'; e.currentTarget.style.boxShadow='0 8px 24px rgba(0,0,0,0.40)' }}
                onMouseLeave={e => { e.currentTarget.style.transform='translateY(0)'; e.currentTarget.style.boxShadow='none' }}
              >
                <img src={item.coverImageUrl} alt={item.titleRomaji} style={s.cover} loading="lazy" />
                <div style={s.cardBody}>
                  <div style={s.titleText}>{pickTitle(item, lang)}</div>
                  <div style={s.meta}>
                    <span style={s.ep}>{t('detail.ep')} {item.episode} {t('detail.epUnit')}</span>
                    <div style={s.timeScore}>
                      <span style={s.time}>{formatTime(item.airingAt)}</span>
                      {item.averageScore > 0 && <span style={s.score}>★ {(item.averageScore / 10).toFixed(1)}</span>}
                    </div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )
      }
    </section>
  )
}

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useWeeklySchedule } from '../../hooks/useAnime'

const DAY_ZH = { 0: '周日', 1: '周一', 2: '周二', 3: '周三', 4: '周四', 5: '周五', 6: '周六' }

function localToday() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function formatDayLabel(dateStr, today) {
  if (dateStr === today) return '今天'
  const d = new Date(dateStr + 'T00:00:00')
  return DAY_ZH[d.getDay()]
}

function formatTime(unixSec) {
  return new Date(unixSec * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

const s = {
  section: { marginTop: 56 },
  header: { marginBottom: 20 },
  label: { color: '#7c3aed', fontSize: 13, fontWeight: 600, letterSpacing: '2px', textTransform: 'uppercase', marginBottom: 8 },
  title: { fontSize: 'clamp(22px,3vw,32px)', background: 'linear-gradient(135deg,#f1f5f9,#94a3b8)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' },
  tabs: { display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 8, marginBottom: 24, scrollbarWidth: 'none' },
  tab: (active, isToday) => ({
    padding: '6px 18px', borderRadius: 20, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: 'none', whiteSpace: 'nowrap', transition: 'all 0.2s',
    background: active ? 'linear-gradient(135deg,#7c3aed,#06b6d4)' : isToday ? 'rgba(124,58,237,0.15)' : 'rgba(255,255,255,0.05)',
    color: active ? '#fff' : isToday ? '#a78bfa' : '#94a3b8',
    outline: isToday && !active ? '1px solid rgba(124,58,237,0.4)' : 'none'
  }),
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
    gap: 14
  },
  card: {
    display: 'flex', flexDirection: 'column',
    borderRadius: 12,
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid rgba(148,163,184,0.08)',
    overflow: 'hidden',
    textDecoration: 'none', color: 'inherit',
    transition: 'transform 0.2s, border-color 0.2s'
  },
  cover: { width: '100%', aspectRatio: '3/4', objectFit: 'cover', display: 'block', background: '#1a2235' },
  cardBody: { padding: '8px 10px 10px' },
  titleText: { fontSize: 13, fontWeight: 600, color: '#f1f5f9', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', lineHeight: 1.4, marginBottom: 6 },
  meta: { display: 'flex', flexDirection: 'column', gap: 4 },
  ep: { fontSize: 11, color: '#7c3aed', fontWeight: 600, background: 'rgba(124,58,237,0.15)', padding: '2px 7px', borderRadius: 4, alignSelf: 'flex-start' },
  timeScore: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  time: { fontSize: 11, color: '#64748b' },
  score: { fontSize: 11, color: '#fbbf24', fontWeight: 600 },
  empty: { color: '#475569', fontSize: 14, padding: '32px 0', textAlign: 'center' }
}

export default function WeeklySchedule() {
  const { data, isLoading } = useWeeklySchedule()
  const today = localToday()
  const [selected, setSelected] = useState(null)

  if (isLoading) return null

  const days    = data ? Object.keys(data.groups).sort() : []
  const active  = selected ?? today
  const activeDay = days.includes(active) ? active : days[0]
  const items   = data?.groups[activeDay] ?? []

  return (
    <section style={s.section}>
      <div style={s.header}>
        <p style={s.label}>放送日历</p>
        <h2 style={s.title}>本周更新</h2>
      </div>

      {/* Day tabs */}
      <div style={s.tabs}>
        {days.map(d => (
          <button
            key={d}
            style={s.tab(d === activeDay, d === today)}
            onClick={() => setSelected(d)}
          >
            {formatDayLabel(d, today)}
            <span style={{ marginLeft: 4, opacity: 0.7, fontSize: 11 }}>
              {data.groups[d]?.length ?? 0}
            </span>
          </button>
        ))}
      </div>

      {/* Anime grid */}
      {items.length === 0
        ? <p style={s.empty}>今日暂无更新</p>
        : (
          <div style={s.grid}>
            {items.map(item => (
              <Link
                key={item.scheduleId}
                to={`/anime/${item.anilistId}`}
                style={s.card}
                onMouseEnter={e => {
                  e.currentTarget.style.transform = 'translateY(-4px)'
                  e.currentTarget.style.borderColor = 'rgba(124,58,237,0.4)'
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.transform = 'translateY(0)'
                  e.currentTarget.style.borderColor = 'rgba(148,163,184,0.08)'
                }}
              >
                <img
                  src={item.coverImageUrl}
                  alt={item.titleRomaji}
                  style={s.cover}
                  loading="lazy"
                />
                <div style={s.cardBody}>
                  <div style={s.titleText}>
                    {item.titleEnglish || item.titleRomaji}
                  </div>
                  <div style={s.meta}>
                    <span style={s.ep}>第 {item.episode} 集</span>
                    <div style={s.timeScore}>
                      <span style={s.time}>{formatTime(item.airingAt)}</span>
                      {item.averageScore > 0 && (
                        <span style={s.score}>★ {(item.averageScore / 10).toFixed(1)}</span>
                      )}
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

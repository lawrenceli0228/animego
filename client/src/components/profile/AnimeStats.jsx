import { useMemo } from 'react'
import { useLang } from '../../context/LanguageContext'
import { useSubscriptions } from '../../hooks/useSubscription'

const STATUS_COLORS = {
  watching: '#0a84ff', completed: '#30d158',
  plan_to_watch: '#ff9f0a', dropped: '#ff453a',
}
const STATUS_LABELS = {
  zh: { watching: '在看', completed: '看完', plan_to_watch: '想看', dropped: '抛弃' },
  en: { watching: 'Watching', completed: 'Completed', plan_to_watch: 'Plan', dropped: 'Dropped' },
}
const SEASON_LABELS = {
  zh: { WINTER: '冬季', SPRING: '春季', SUMMER: '夏季', FALL: '秋季' },
  en: { WINTER: 'Winter', SPRING: 'Spring', SUMMER: 'Summer', FALL: 'Fall' },
}

function DonutChart({ segments, size = 80 }) {
  const total = segments.reduce((s, seg) => s + seg.value, 0)
  if (!total) return null
  const r = (size / 2) - 7
  const cx = size / 2, cy = size / 2
  const circumference = 2 * Math.PI * r
  let offset = 0

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {segments.filter(s => s.value > 0).map((seg, i) => {
        const pct = seg.value / total
        const dash = circumference * pct
        const gap = circumference - dash
        const cur = offset
        offset += pct * circumference
        return (
          <circle key={i} cx={cx} cy={cy} r={r}
            fill="none" stroke={seg.color} strokeWidth={10}
            strokeDasharray={`${dash} ${gap}`}
            strokeDashoffset={-cur}
            style={{ transform: 'rotate(-90deg)', transformOrigin: 'center' }}
          />
        )
      })}
      <text x={cx} y={cy + 6} textAnchor="middle" fill="#fff"
        style={{ fontSize: 20, fontWeight: 700, fontFamily: "'Sora',sans-serif" }}>
        {total}
      </text>
    </svg>
  )
}

export default function AnimeStats() {
  const { lang } = useLang()
  const { data: allSubs, isLoading } = useSubscriptions()

  const stats = useMemo(() => {
    if (!allSubs?.length) return null

    const statusCounts = { watching: 0, completed: 0, plan_to_watch: 0, dropped: 0 }
    const genreCounts = {}
    const seasonCounts = {}

    for (const item of allSubs) {
      statusCounts[item.status] = (statusCounts[item.status] || 0) + 1
      if (item.genres) {
        for (const g of item.genres) genreCounts[g] = (genreCounts[g] || 0) + 1
      }
      if (item.season && item.seasonYear) {
        const key = `${item.seasonYear}-${item.season}`
        seasonCounts[key] = (seasonCounts[key] || 0) + 1
      }
    }

    const topGenres = Object.entries(genreCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([label]) => label)

    const topSeason = Object.entries(seasonCounts)
      .sort((a, b) => b[1] - a[1])[0]

    const statusSegments = Object.entries(statusCounts)
      .filter(([, v]) => v > 0)
      .map(([key, value]) => ({ value, color: STATUS_COLORS[key] }))

    return { statusCounts, statusSegments, topGenres, topSeason }
  }, [allSubs, lang])

  if (isLoading || !stats) return null

  const sLabel = STATUS_LABELS[lang] || STATUS_LABELS.en
  const seasonLabel = SEASON_LABELS[lang] || SEASON_LABELS.en

  const topSeasonText = stats.topSeason
    ? `${stats.topSeason[0].split('-')[0]} ${seasonLabel[stats.topSeason[0].split('-')[1]] || ''}`
    : null

  return (
    <div style={{
      background: '#1c1c1e', border: '1px solid #38383a', borderRadius: 14,
      padding: '16px 20px', marginBottom: 28,
      display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap',
    }}>
      {/* Donut */}
      <DonutChart segments={stats.statusSegments} />

      {/* Status legend */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {Object.entries(STATUS_COLORS).map(([key, color]) => {
          const count = stats.statusCounts[key]
          if (!count) return null
          return (
            <span key={key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'rgba(235,235,245,0.70)' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
              {sLabel[key]}
              <span style={{ fontWeight: 600, color: '#fff', fontVariantNumeric: 'tabular-nums' }}>{count}</span>
            </span>
          )
        })}
      </div>

      {/* Divider */}
      {stats.topGenres.length > 0 && (
        <div style={{ width: 1, height: 48, background: '#38383a', flexShrink: 0 }} />
      )}

      {/* Top genres */}
      {stats.topGenres.length > 0 && (
        <div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>
            {stats.topGenres.map(g => (
              <span key={g} style={{
                padding: '3px 10px', borderRadius: 20, fontSize: 12, fontWeight: 500,
                border: '1px solid #48484a', color: '#fff', background: 'transparent',
              }}>{g}</span>
            ))}
          </div>
          <p style={{ fontSize: 11, color: 'rgba(235,235,245,0.30)', margin: 0 }}>
            {lang === 'zh' ? '常追类型' : 'Top Genres'}
          </p>
        </div>
      )}

      {/* Divider */}
      {topSeasonText && (
        <div style={{ width: 1, height: 48, background: '#38383a', flexShrink: 0 }} />
      )}

      {/* Most active season */}
      {topSeasonText && (
        <div>
          <p style={{
            fontSize: 16, fontWeight: 700, color: '#fff', margin: 0,
            fontFamily: "'Sora',sans-serif",
          }}>{topSeasonText}</p>
          <p style={{ fontSize: 11, color: 'rgba(235,235,245,0.30)', margin: 0 }}>
            {lang === 'zh' ? '最活跃赛季' : 'Most Active Season'}
          </p>
        </div>
      )}
    </div>
  )
}

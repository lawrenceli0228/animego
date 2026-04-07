import { useLang } from '../../context/LanguageContext'

const STATUS_COLORS = {
  watching:      '#0a84ff',
  completed:     '#30d158',
  plan_to_watch: '#5ac8fa',
  dropped:       '#ff453a',
}
const STATUS_ORDER = ['watching', 'completed', 'plan_to_watch', 'dropped']
const R = 38
const C = 2 * Math.PI * R // ≈ 238.8

function DonutChart({ counts, total }) {
  if (total === 0) {
    return (
      <svg width={88} height={88} viewBox="0 0 88 88">
        <circle cx={44} cy={44} r={R} fill="none" stroke="#2c2c2e" strokeWidth={10} />
      </svg>
    )
  }

  let cumulative = 0
  const segments = STATUS_ORDER.map(key => {
    const count = counts[key] || 0
    const len   = (count / total) * C
    const start = cumulative
    cumulative += len
    return { key, count, len, start }
  }).filter(s => s.count > 0)

  return (
    <svg width={88} height={88} viewBox="0 0 88 88">
      <circle cx={44} cy={44} r={R} fill="none" stroke="#2c2c2e" strokeWidth={10} />
      {segments.map(({ key, len, start }) => (
        <circle
          key={key}
          cx={44} cy={44} r={R}
          fill="none"
          stroke={STATUS_COLORS[key]}
          strokeWidth={10}
          strokeDasharray={`${len} ${C}`}
          strokeDashoffset={-start}
          style={{ transform: 'rotate(-90deg)', transformOrigin: '44px 44px' }}
        />
      ))}
      {/* total count in center */}
      <text x={44} y={44} textAnchor="middle" dominantBaseline="central"
        fill="#ffffff" fontSize={16} fontWeight={700} fontFamily="DM Sans, sans-serif">
        {total}
      </text>
    </svg>
  )
}

export default function UserStatsPanel({ watching }) {
  const { t, lang } = useLang()

  const total = watching.length
  if (total === 0) return null

  // Single pass: status counts, episode total, genre counts, season counts
  const counts = {}
  const genreCounts = {}
  const seasonCounts = {}
  let totalEps = 0

  for (const a of watching) {
    counts[a.subscriptionStatus] = (counts[a.subscriptionStatus] || 0) + 1
    totalEps += a.currentEpisode || 0
    for (const g of a.genres || []) {
      genreCounts[g] = (genreCounts[g] || 0) + 1
    }
    if (a.season && a.seasonYear) {
      const k = `${a.season}-${a.seasonYear}`
      seasonCounts[k] = (seasonCounts[k] || 0) + 1
    }
  }

  const topGenres = Object.entries(genreCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([g]) => g)
  const topSeasonKey = Object.entries(seasonCounts).sort((a, b) => b[1] - a[1])[0]?.[0]
  let topSeasonLabel = null
  if (topSeasonKey) {
    const [season, year] = topSeasonKey.split('-')
    const seasonName = t(`season.${season}`).replace(/\s*[❄️🌸☀️🍂]/u, '').trim()
    topSeasonLabel = lang === 'zh' ? `${year} ${seasonName}` : `${seasonName} ${year}`
  }

  const statusLabels = {
    watching:      t('sub.watching'),
    completed:     t('sub.completed'),
    plan_to_watch: t('sub.planToWatch'),
    dropped:       t('sub.dropped'),
  }

  return (
    <div style={{
      background: '#1c1c1e', borderRadius: 12, padding: '20px 24px',
      marginBottom: 32, display: 'flex', gap: 24, alignItems: 'center',
      flexWrap: 'wrap',
    }}>
      {/* Donut */}
      <DonutChart counts={counts} total={total} />

      {/* Status legend */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 20px', flexShrink: 0 }}>
        {STATUS_ORDER.map(s => counts[s] > 0 && (
          <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_COLORS[s], flexShrink: 0 }} />
            <span style={{ color: 'rgba(235,235,245,0.60)', fontSize: 12 }}>{statusLabels[s]}</span>
            <span style={{ color: '#ffffff', fontSize: 12, fontWeight: 700, marginLeft: 2 }}>{counts[s]}</span>
          </div>
        ))}
      </div>

      {/* Divider */}
      <div style={{ width: 1, height: 56, background: '#38383a', flexShrink: 0, alignSelf: 'center' }} />

      {/* Stat items */}
      <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
        {totalEps > 0 && (
          <div>
            <div style={{ color: '#ffffff', fontSize: 22, fontWeight: 800, lineHeight: 1 }}>{totalEps}</div>
            <div style={{ color: 'rgba(235,235,245,0.45)', fontSize: 11, marginTop: 3 }}>{t('social.statsEpisodes')}</div>
          </div>
        )}
        {topGenres.length > 0 && (
          <div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 3 }}>
              {topGenres.map(g => (
                <span key={g} style={{
                  fontSize: 11, padding: '2px 8px', borderRadius: 99,
                  background: 'rgba(10,132,255,0.12)', color: '#0a84ff',
                  fontWeight: 600,
                }}>{g}</span>
              ))}
            </div>
            <div style={{ color: 'rgba(235,235,245,0.45)', fontSize: 11 }}>{t('social.statsGenres')}</div>
          </div>
        )}
        {topSeasonLabel && (
          <div>
            <div style={{ color: '#ffffff', fontSize: 14, fontWeight: 700, lineHeight: 1.4 }}>{topSeasonLabel}</div>
            <div style={{ color: 'rgba(235,235,245,0.45)', fontSize: 11, marginTop: 2 }}>{t('social.statsSeason')}</div>
          </div>
        )}
      </div>
    </div>
  )
}

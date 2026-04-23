const stats = [
  { value: '12,480', label: '部番剧', note: '覆盖 2005 - 至今', hue: 330 },
  { value: '3.2M',   label: '弹幕条数', note: '日均新增 8k+',   hue: 210 },
  { value: '48',     label: '数据源',   note: '多源聚合播放',   hue: 155 },
  { value: '200+',   label: '日更话数', note: '每日凌晨抓取',   hue: 40  },
]

const s = {
  section: {
    position: 'relative',
    padding: 'clamp(48px, 4vw, 80px) 0',
    borderBottom: '1px solid rgba(84,84,88,0.30)',
    background: '#000',
  },
  sectionNum: {
    position: 'absolute',
    top: 20, right: 32,
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    letterSpacing: '0.14em',
    color: 'rgba(235,235,245,0.30)',
    textTransform: 'uppercase',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: 'clamp(24px, 3vw, 56px)',
  },
  cell: {
    position: 'relative',
    paddingLeft: 20,
  },
  bar: (hue) => ({
    position: 'absolute',
    left: 0, top: 4,
    width: 3, height: 44,
    background: `oklch(62% 0.19 ${hue})`,
    borderRadius: 2,
    boxShadow: `0 0 20px oklch(62% 0.19 ${hue} / 0.45)`,
  }),
  value: {
    fontFamily: "'Sora', sans-serif",
    fontSize: 'clamp(2.25rem, 1rem + 3.5vw, 4.25rem)',
    fontWeight: 800,
    letterSpacing: '-0.03em',
    lineHeight: 1,
    color: '#fff',
    fontVariantNumeric: 'tabular-nums',
  },
  label: {
    fontFamily: "'DM Sans', sans-serif",
    fontSize: 13,
    color: 'rgba(235,235,245,0.60)',
    marginTop: 10,
    letterSpacing: '0.02em',
  },
  note: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    color: 'rgba(235,235,245,0.30)',
    marginTop: 6,
    letterSpacing: '0.04em',
  },
}

export default function StatsRow() {
  return (
    <section style={s.section} aria-label="平台数据">
      <style>{`
        @media (max-width: 880px) {
          .stats-grid { grid-template-columns: repeat(2, 1fr) !important; gap: 32px !important; }
        }
      `}</style>
      <span style={s.sectionNum} aria-hidden>§02</span>
      <div className="container">
        <div className="stats-grid" style={s.grid}>
          {stats.map((stat) => (
            <div key={stat.label} style={s.cell}>
              <span style={s.bar(stat.hue)} />
              <div style={s.value}>{stat.value}</div>
              <div style={s.label}>{stat.label}</div>
              <div style={s.note}>{stat.note}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

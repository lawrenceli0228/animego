import { useLang } from '../../context/LanguageContext'

const SEASONS = ['WINTER', 'SPRING', 'SUMMER', 'FALL']
const currentYear = new Date().getFullYear()
const years = Array.from({ length: currentYear - 1999 }, (_, i) => currentYear + 1 - i)

const s = {
  wrap: { display:'flex', alignItems:'center', gap:16, flexWrap:'wrap', marginBottom:24 },
  select: {
    padding:'8px 14px', borderRadius:8,
    background:'#1a2235', border:'1px solid rgba(124,58,237,0.3)',
    color:'#f1f5f9', fontSize:14, cursor:'pointer', outline:'none'
  },
  tabs: { display:'flex', gap:4, background:'rgba(26,34,53,0.8)',
    borderRadius:10, padding:4, border:'1px solid rgba(148,163,184,0.08)' },
  tab: (active) => ({
    padding:'6px 16px', borderRadius:7, fontSize:14, fontWeight:600,
    cursor:'pointer', border:'none', transition:'all 0.2s',
    background: active ? 'linear-gradient(135deg,#7c3aed,#6d28d9)' : 'transparent',
    color: active ? '#fff' : '#94a3b8',
    boxShadow: active ? '0 4px 12px rgba(124,58,237,0.3)' : 'none'
  })
}

export default function SeasonSelector({ year, season, onYearChange, onSeasonChange }) {
  const { t } = useLang()
  return (
    <div style={s.wrap}>
      <select style={s.select} value={year} onChange={e => onYearChange(Number(e.target.value))}>
        {years.map(y => <option key={y} value={y}>{y} {t('season.year')}</option>)}
      </select>
      <div style={s.tabs}>
        {SEASONS.map(s_ => (
          <button key={s_} style={s.tab(season === s_)} onClick={() => onSeasonChange(s_)}>
            {t(`season.${s_}`)}
          </button>
        ))}
      </div>
    </div>
  )
}

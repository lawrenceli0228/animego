import { useLang } from '../../context/LanguageContext'

const SEASONS = ['WINTER', 'SPRING', 'SUMMER', 'FALL']
const currentYear = new Date().getFullYear()
const years = Array.from({ length: currentYear - 1999 }, (_, i) => currentYear + 1 - i)

const s = {
  wrap: { display:'flex', alignItems:'center', gap:16, flexWrap:'wrap', marginBottom:24 },
  select: {
    padding:'8px 14px', borderRadius:8,
    background:'#2c2c2e', border:'1px solid #38383a',
    color:'#ffffff', fontSize:14, cursor:'pointer', outline:'none'
  },
  tabs: { display:'flex', gap:4, background:'#1c1c1e',
    borderRadius:10, padding:4, border:'1px solid #38383a' },
  tab: (active) => ({
    padding:'6px 16px', borderRadius:7, fontSize:14, fontWeight: active ? 600 : 500,
    cursor:'pointer', border:'none', transition:'all 0.2s',
    background: active ? '#0a84ff' : 'transparent',
    color: active ? '#fff' : 'rgba(235,235,245,0.60)',
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

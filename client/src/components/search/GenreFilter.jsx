import { GENRES } from '../../utils/constants'

export default function GenreFilter({ selected, onSelect }) {
  return (
    <div style={{ display:'flex', flexWrap:'wrap', gap:6, marginBottom:16 }}>
      {GENRES.map(g => {
        const active = selected === g
        return (
          <button key={g} onClick={() => onSelect(active ? '' : g)}
            style={{
              padding:'4px 10px', borderRadius:9999, fontSize:12, fontWeight:500,
              cursor:'pointer', transition:'all 0.2s',
              background: active ? 'rgba(10,132,255,0.12)' : 'rgba(120,120,128,0.12)',
              border: `1px solid ${active ? 'rgba(10,132,255,0.5)' : 'transparent'}`,
              color: active ? '#0a84ff' : 'rgba(235,235,245,0.60)'
            }}>{g}</button>
        )
      })}
    </div>
  )
}

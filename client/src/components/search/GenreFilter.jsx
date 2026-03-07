import { GENRES } from '../../utils/constants'

export default function GenreFilter({ selected, onSelect }) {
  return (
    <div style={{ display:'flex', flexWrap:'wrap', gap:6, marginBottom:16 }}>
      {GENRES.map(g => {
        const active = selected === g
        return (
          <button key={g} onClick={() => onSelect(active ? '' : g)}
            style={{
              padding:'5px 12px', borderRadius:20, fontSize:12, fontWeight:500,
              cursor:'pointer', border:'1px solid', transition:'all 0.2s',
              background: active ? 'rgba(124,58,237,0.25)' : 'transparent',
              borderColor: active ? 'rgba(124,58,237,0.6)' : 'rgba(148,163,184,0.15)',
              color: active ? '#c4b5fd' : '#94a3b8'
            }}>{g}</button>
        )
      })}
    </div>
  )
}

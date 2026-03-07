import { useState, useEffect } from 'react'

export default function SearchBar({ value, onChange }) {
  const [local, setLocal] = useState(value)

  useEffect(() => { setLocal(value) }, [value])

  useEffect(() => {
    const t = setTimeout(() => { if (local !== value) onChange(local) }, 400)
    return () => clearTimeout(t)
  }, [local])

  return (
    <div style={{ position:'relative', flex:1, minWidth:240, maxWidth:480 }}>
      <span style={{ position:'absolute', left:14, top:'50%', transform:'translateY(-50%)',
        color:'#64748b', fontSize:16, pointerEvents:'none' }}>🔍</span>
      <input
        type="text"
        value={local}
        onChange={e => setLocal(e.target.value)}
        placeholder="搜索番剧名称..."
        style={{
          width:'100%', padding:'10px 14px 10px 42px',
          borderRadius:10, border:'1px solid rgba(124,58,237,0.3)',
          background:'#1a2235', color:'#f1f5f9', fontSize:14,
          outline:'none', transition:'border-color 0.2s'
        }}
        onFocus={e => e.target.style.borderColor='rgba(124,58,237,0.7)'}
        onBlur={e => e.target.style.borderColor='rgba(124,58,237,0.3)'}
      />
    </div>
  )
}

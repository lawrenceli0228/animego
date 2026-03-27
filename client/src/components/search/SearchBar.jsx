import { useState, useEffect } from 'react'
import { useLang } from '../../context/LanguageContext'

export default function SearchBar({ value, onChange }) {
  const [local, setLocal] = useState(value)
  const { t } = useLang()

  useEffect(() => { setLocal(value) }, [value])

  useEffect(() => {
    const timer = setTimeout(() => { if (local !== value) onChange(local) }, 400)
    return () => clearTimeout(timer)
  }, [local])

  return (
    <div style={{ position:'relative', flex:1, minWidth:240, maxWidth:480 }}>
      <span style={{ position:'absolute', left:14, top:'50%', transform:'translateY(-50%)',
        color:'rgba(235,235,245,0.30)', fontSize:16, pointerEvents:'none' }}>🔍</span>
      <input
        type="text"
        value={local}
        onChange={e => setLocal(e.target.value)}
        placeholder={t('search.placeholder')}
        style={{
          width:'100%', padding:'10px 14px 10px 42px',
          borderRadius:10, border:'1px solid rgba(10,132,255,0.3)',
          background:'#2c2c2e', color:'#ffffff', fontSize:14,
          outline:'none', transition:'border-color 0.2s'
        }}
        onFocus={e => e.target.style.borderColor='rgba(10,132,255,0.7)'}
        onBlur={e => e.target.style.borderColor='rgba(10,132,255,0.3)'}
      />
    </div>
  )
}

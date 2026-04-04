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
      <span style={{ position:'absolute', left:16, top:'50%', transform:'translateY(-50%)',
        color:'rgba(235,235,245,0.30)', fontSize:16, pointerEvents:'none' }}>🔍</span>
      <input
        type="text"
        value={local}
        onChange={e => setLocal(e.target.value)}
        placeholder={t('search.placeholder')}
        style={{
          width:'100%', padding:'12px 16px 12px 44px',
          borderRadius:9999, border:'1px solid #38383a',
          background:'#2c2c2e', color:'#ffffff', fontSize:14,
          outline:'none', transition:'border-color 0.2s, box-shadow 0.2s'
        }}
        onFocus={e => { e.target.style.borderColor='#0a84ff'; e.target.style.boxShadow='0 0 0 3px rgba(10,132,255,0.25)' }}
        onBlur={e => { e.target.style.borderColor='#38383a'; e.target.style.boxShadow='none' }}
      />
    </div>
  )
}

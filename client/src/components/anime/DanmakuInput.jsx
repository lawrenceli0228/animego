import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { useLang } from '../../context/LanguageContext'

const MAX_LEN = 50

export default function DanmakuInput({ onSend, connected }) {
  const { user } = useAuth()
  const navigate = useNavigate()
  const { t } = useLang()
  const [value, setValue] = useState('')

  if (!user) return (
    <div style={{ fontSize: 12, color: '#475569', textAlign: 'center', padding: '8px 0' }}>
      <button
        onClick={() => navigate('/login')}
        style={{ color: '#a78bfa', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 12 }}
      >
        {t('sub.loginToWatch')}
      </button>
      {' '}{t('danmaku.loginSuffix')}
    </div>
  )

  const handleSend = () => {
    const trimmed = value.trim()
    if (!trimmed) return
    onSend(trimmed)
    setValue('')
  }

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <div style={{
        width: 6, height: 6, borderRadius: '50%',
        background: connected ? '#34d399' : '#475569',
        flexShrink: 0, transition: 'background 0.3s',
      }} title={connected ? t('danmaku.connected') : t('danmaku.connecting')} />

      <input
        value={value}
        onChange={e => setValue(e.target.value.slice(0, MAX_LEN))}
        onKeyDown={e => e.key === 'Enter' && handleSend()}
        placeholder={t('danmaku.placeholder')}
        maxLength={MAX_LEN}
        style={{
          flex: 1, padding: '7px 12px', borderRadius: 8,
          border: '1px solid rgba(148,163,184,0.2)',
          background: 'rgba(255,255,255,0.04)', color: '#f1f5f9',
          fontSize: 13, outline: 'none',
        }}
      />
      <span style={{ fontSize: 11, color: '#475569', flexShrink: 0 }}>
        {value.length}/{MAX_LEN}
      </span>
      <button
        onClick={handleSend}
        disabled={!value.trim() || !connected}
        style={{
          padding: '7px 16px', borderRadius: 8, border: 'none',
          background: value.trim() && connected ? '#7c3aed' : 'rgba(124,58,237,0.2)',
          color: value.trim() && connected ? '#fff' : '#64748b',
          fontSize: 13, fontWeight: 600, cursor: value.trim() && connected ? 'pointer' : 'default',
          transition: 'all 0.2s', flexShrink: 0,
        }}
      >
        {t('danmaku.send')}
      </button>
    </div>
  )
}

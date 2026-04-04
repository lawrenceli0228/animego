import { useState } from 'react'
import { Link } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useAuth } from '../../context/AuthContext'
import { useLang } from '../../context/LanguageContext'
import { useSubscription, useAddSubscription, useUpdateSubscription, useRemoveSubscription } from '../../hooks/useSubscription'
import { STATUS_OPTIONS } from '../../utils/constants'

const s = {
  wrap: { display:'flex', flexWrap:'wrap', alignItems:'center', gap:12, padding:'24px 0' },
  select: {
    padding:'10px 16px', borderRadius:8,
    background:'#2c2c2e', border:'1px solid #38383a',
    color:'#ffffff', fontSize:14, cursor:'pointer',
    outline:'none', minWidth:150
  },
  epWrap: { display:'flex', alignItems:'center', gap:6, background:'#2c2c2e',
    border:'1px solid #38383a', borderRadius:8, padding:'4px 8px' },
  epBtn: { width:28, height:28, borderRadius:6, background:'rgba(10,132,255,0.12)',
    color:'#0a84ff', fontSize:16, display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer',
    border:'none', transition:'background 0.2s' },
  epNum: { minWidth:32, textAlign:'center', fontSize:14, fontWeight:600, color:'#ffffff',
    fontVariantNumeric:'tabular-nums' },
  removeBtn: { padding:'10px 16px', borderRadius:8, border:'1px solid rgba(255,69,58,0.4)',
    color:'#ff453a', fontSize:13, cursor:'pointer', background:'rgba(255,69,58,0.08)', transition:'all 0.2s' },
  loginBtn: {
    display:'inline-block', padding:'10px 24px', borderRadius:8,
    background:'#0a84ff',
    color:'#fff', fontWeight:500, fontSize:14, textDecoration:'none'
  }
}

export default function SubscriptionButton({ anilistId, episodes }) {
  const { user } = useAuth()
  const { t } = useLang()
  const { data: sub, isLoading } = useSubscription(anilistId)
  const add    = useAddSubscription()
  const update = useUpdateSubscription()
  const remove = useRemoveSubscription()
  const [epInput, setEpInput] = useState(null)

  const statusLabels = {
    watching: t('sub.watching'), completed: t('sub.completed'),
    plan_to_watch: t('sub.planToWatch'), dropped: t('sub.dropped')
  }

  if (!user) return <Link to="/login" style={s.loginBtn}>{t('sub.loginToWatch')}</Link>
  if (isLoading) return null

  const currentEp = epInput ?? sub?.currentEpisode ?? 0
  const currentStatus = sub?.status

  const handleStatus = async (status) => {
    try {
      if (!sub) await add.mutateAsync({ anilistId, status })
      else await update.mutateAsync({ anilistId, status })
      toast.success('✓')
    } catch { toast.error('!') }
  }

  const handleEp = async (ep) => {
    const val = Math.max(0, Math.min(ep, episodes || 9999))
    setEpInput(val)
    try {
      if (!sub) await add.mutateAsync({ anilistId, status: 'watching', currentEpisode: val })
      else await update.mutateAsync({ anilistId, currentEpisode: val })
    } catch { toast.error('!') }
  }

  const handleRemove = async () => {
    try {
      await remove.mutateAsync(anilistId)
      setEpInput(null)
      toast.success('✓')
    } catch { toast.error('!') }
  }

  return (
    <div style={s.wrap}>
      <select style={s.select} value={currentStatus || ''} onChange={e => handleStatus(e.target.value)}>
        <option value="" disabled>{t('sub.addToList')}</option>
        {STATUS_OPTIONS.map(o => (
          <option key={o.value} value={o.value}>{statusLabels[o.value]}</option>
        ))}
      </select>

      {sub && (
        <div style={s.epWrap}>
          <button style={s.epBtn} onClick={() => handleEp(currentEp - 1)}>−</button>
          <span style={s.epNum}>{currentEp}</span>
          <button style={s.epBtn} onClick={() => handleEp(currentEp + 1)}>+</button>
          <span style={{ fontSize:12, color:'rgba(235,235,245,0.30)', marginLeft:4 }}>
            {episodes ? `/ ${episodes} ${t('sub.epUnit')}` : t('sub.epUnit')}
          </span>
        </div>
      )}

      {sub && (
        <button style={s.removeBtn} onClick={handleRemove}>{t('sub.remove')}</button>
      )}
    </div>
  )
}

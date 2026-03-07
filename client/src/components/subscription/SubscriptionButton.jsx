import { useState } from 'react'
import { Link } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useAuth } from '../../context/AuthContext'
import { useSubscription, useAddSubscription, useUpdateSubscription, useRemoveSubscription } from '../../hooks/useSubscription'
import { STATUS_OPTIONS } from '../../utils/constants'
import { formatEpisodes } from '../../utils/formatters'

const s = {
  wrap: { display:'flex', flexWrap:'wrap', alignItems:'center', gap:12, padding:'24px 0' },
  select: {
    padding:'10px 16px', borderRadius:10,
    background:'#1a2235', border:'1px solid rgba(124,58,237,0.4)',
    color:'#f1f5f9', fontSize:14, cursor:'pointer',
    outline:'none', minWidth:150
  },
  epWrap: { display:'flex', alignItems:'center', gap:6, background:'#1a2235',
    border:'1px solid rgba(148,163,184,0.12)', borderRadius:10, padding:'4px 8px' },
  epBtn: { width:28, height:28, borderRadius:6, background:'rgba(124,58,237,0.2)',
    color:'#f1f5f9', fontSize:16, display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer',
    border:'none', transition:'background 0.2s' },
  epNum: { minWidth:32, textAlign:'center', fontSize:14, fontWeight:600, color:'#f1f5f9' },
  removeBtn: { padding:'10px 16px', borderRadius:10, border:'1px solid rgba(239,68,68,0.4)',
    color:'#f87171', fontSize:13, cursor:'pointer', background:'rgba(239,68,68,0.05)', transition:'all 0.2s' },
  loginBtn: {
    display:'inline-block', padding:'10px 24px', borderRadius:10,
    background:'linear-gradient(135deg,#7c3aed,#06b6d4)',
    color:'#fff', fontWeight:600, fontSize:14
  }
}

export default function SubscriptionButton({ anilistId, episodes }) {
  const { user } = useAuth()
  const { data: sub, isLoading } = useSubscription(anilistId)
  const add    = useAddSubscription()
  const update = useUpdateSubscription()
  const remove = useRemoveSubscription()
  const [epInput, setEpInput] = useState(null)

  if (!user) return <Link to="/login" style={s.loginBtn}>登录后追番</Link>
  if (isLoading) return null

  const currentEp = epInput ?? sub?.currentEpisode ?? 0
  const currentStatus = sub?.status

  const handleStatus = async (status) => {
    try {
      if (!sub) await add.mutateAsync({ anilistId, status })
      else await update.mutateAsync({ anilistId, status })
      toast.success('已更新')
    } catch { toast.error('操作失败') }
  }

  const handleEp = async (ep) => {
    const val = Math.max(0, Math.min(ep, episodes || 9999))
    setEpInput(val)
    try {
      if (!sub) await add.mutateAsync({ anilistId, status: 'watching', currentEpisode: val })
      else await update.mutateAsync({ anilistId, currentEpisode: val })
    } catch { toast.error('更新失败') }
  }

  const handleRemove = async () => {
    try {
      await remove.mutateAsync(anilistId)
      setEpInput(null)
      toast.success('已移除')
    } catch { toast.error('操作失败') }
  }

  return (
    <div style={s.wrap}>
      <select style={s.select} value={currentStatus || ''} onChange={e => handleStatus(e.target.value)}>
        <option value="" disabled>+ 添加到列表</option>
        {STATUS_OPTIONS.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>

      {sub && (
        <div style={s.epWrap}>
          <button style={s.epBtn} onClick={() => handleEp(currentEp - 1)}>−</button>
          <span style={s.epNum}>{currentEp}</span>
          <button style={s.epBtn} onClick={() => handleEp(currentEp + 1)}>+</button>
          <span style={{ fontSize:12, color:'#64748b', marginLeft:4 }}>
            {episodes ? `/ ${episodes} 集` : '集'}
          </span>
        </div>
      )}

      {sub && (
        <button style={s.removeBtn} onClick={handleRemove}>移除</button>
      )}
    </div>
  )
}

import { useState, useRef, useEffect } from 'react'
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
  const [statusHint, setStatusHint] = useState(null)
  const [scoreOpen, setScoreOpen] = useState(false)
  const scoreRef = useRef(null)

  const statusLabels = {
    watching: t('sub.watching'), completed: t('sub.completed'),
    plan_to_watch: t('sub.planToWatch'), dropped: t('sub.dropped')
  }

  useEffect(() => {
    if (!scoreOpen) return
    const handler = (e) => { if (scoreRef.current && !scoreRef.current.contains(e.target)) setScoreOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [scoreOpen])

  if (!user) return <Link to="/login" style={s.loginBtn}>{t('sub.loginToWatch')}</Link>
  if (isLoading) return null

  const currentEp = epInput ?? sub?.currentEpisode ?? 0
  const currentStatus = sub?.status
  const currentScore = sub?.score ?? null

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
      const autoComplete = episodes > 0 && val >= episodes
      const autoResume = episodes > 0 && val < episodes && currentStatus === 'completed'
      const newStatus = autoComplete ? 'completed' : autoResume ? 'watching' : undefined
      if (!sub) await add.mutateAsync({ anilistId, status: autoComplete ? 'completed' : 'watching', currentEpisode: val })
      else await update.mutateAsync({ anilistId, currentEpisode: val, ...(newStatus && { status: newStatus }) })
      if (autoComplete) {
        setStatusHint('completed')
        setTimeout(() => setStatusHint(null), 2500)
      }
    } catch { toast.error('!') }
  }

  const handleScore = async (val) => {
    const newScore = val === currentScore ? null : val
    try {
      await update.mutateAsync({ anilistId, score: newScore })
      setScoreOpen(false)
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
        <div style={{ position: 'relative' }}>
          {statusHint && (
            <div style={{
              position: 'absolute', bottom: 'calc(100% + 6px)', left: '50%', transform: 'translateX(-50%)',
              background: statusHint === 'completed' ? 'rgba(48,209,88,0.15)' : 'rgba(10,132,255,0.15)',
              border: `1px solid ${statusHint === 'completed' ? 'rgba(48,209,88,0.4)' : 'rgba(10,132,255,0.4)'}`,
              borderRadius: 8, padding: '4px 12px', whiteSpace: 'nowrap',
              fontSize: 12, fontWeight: 600,
              color: statusHint === 'completed' ? '#30d158' : '#0a84ff',
              animation: 'fadeUp 0.3s ease both',
            }}>
              {statusLabels[statusHint]} ✓
            </div>
          )}
        <div style={s.epWrap}>
          <button style={s.epBtn} onClick={() => handleEp(currentEp - 1)}>−</button>
          <span style={s.epNum}>{currentEp}</span>
          <button style={s.epBtn} onClick={() => handleEp(currentEp + 1)}>+</button>
          <span style={{ fontSize:12, color:'rgba(235,235,245,0.30)', marginLeft:4 }}>
            {episodes ? `/ ${episodes} ${t('sub.epUnit')}` : t('sub.epUnit')}
          </span>
        </div>
        </div>
      )}

      {sub && (
        <div ref={scoreRef} style={{ position:'relative' }}>
          <button
            onClick={() => setScoreOpen(!scoreOpen)}
            style={{
              padding:'8px 14px', borderRadius:8,
              background: currentScore ? 'rgba(10,132,255,0.12)' : '#2c2c2e',
              border: currentScore ? '1px solid rgba(10,132,255,0.4)' : '1px solid #38383a',
              color: currentScore ? '#0a84ff' : 'rgba(235,235,245,0.60)',
              fontSize:13, fontWeight:600, cursor:'pointer',
              fontVariantNumeric:'tabular-nums'
            }}
          >
            ★ {currentScore ? `${currentScore}/10` : t('sub.rate')}
          </button>
          {scoreOpen && (
            <div style={{
              position:'absolute', top:'calc(100% + 6px)', left:0, zIndex:100,
              background:'#2c2c2e', border:'1px solid #38383a', borderRadius:10,
              padding:'8px', display:'flex', gap:4, boxShadow:'0 8px 24px rgba(0,0,0,0.5)'
            }}>
              {[1,2,3,4,5,6,7,8,9,10].map(n => (
                <button key={n} onClick={() => handleScore(n)} style={{
                  width:30, height:30, borderRadius:6, border:'none', cursor:'pointer',
                  fontSize:12, fontWeight:700, fontVariantNumeric:'tabular-nums',
                  background: n === currentScore ? '#0a84ff' : 'rgba(120,120,128,0.12)',
                  color: n === currentScore ? '#fff' : n <= (currentScore || 0) ? '#0a84ff' : 'rgba(235,235,245,0.60)',
                  transition:'all 0.15s'
                }}>{n}</button>
              ))}
            </div>
          )}
        </div>
      )}

      {sub && (
        <button style={s.removeBtn} onClick={handleRemove}>{t('sub.remove')}</button>
      )}
    </div>
  )
}

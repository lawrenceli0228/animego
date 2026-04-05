import { useMemo } from 'react'
import { useLang } from '../../context/LanguageContext'
import { useAuth } from '../../context/AuthContext'
import { useDanmakuHistory, useDanmakuSocket } from '../../hooks/useDanmaku'
import DanmakuOverlay from './DanmakuOverlay'
import DanmakuInput from './DanmakuInput'

export default function DanmakuSection({ anilistId, episode }) {
  const { t } = useLang()
  const { user } = useAuth()

  const { data: history } = useDanmakuHistory(anilistId, episode, true)
  const liveEndsAt = history?.liveEndsAt ? new Date(history.liveEndsAt) : null
  // isLive: badge — only when a window has been explicitly started AND not expired
  // canSend: input — also covers "never started" so the first user can open the window
  const isLive  = liveEndsAt !== null && Date.now() < liveEndsAt.getTime()
  const canSend = !liveEndsAt || Date.now() < liveEndsAt.getTime()

  const { live, connected, send } = useDanmakuSocket(anilistId, episode, !!user && canSend)

  // Merge history + live, deduplicated by _id
  const allMessages = useMemo(() => {
    const hist = history?.data ?? []
    const ids  = new Set(hist.map(m => String(m._id)))
    const fresh = live.filter(m => !ids.has(String(m._id)))
    return [...hist, ...fresh]
  }, [history, live])

  return (
    <div style={{
      borderTop: '1px solid #38383a',
      paddingTop: 12, marginTop: 4,
    }}>
      {/* Label */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <p style={{ color: '#5ac8fa', fontSize: 12, fontWeight: 600, letterSpacing: '2px', textTransform: 'uppercase' }}>
          {t('danmaku.label')}
        </p>
        {allMessages.length > 0 && (
          <span style={{ fontSize: 11, color: 'rgba(235,235,245,0.30)' }}>{allMessages.length}</span>
        )}
        {isLive && (
          <span style={{
            fontSize: 10, fontWeight: 700, color: '#30d158',
            background: 'rgba(48,209,88,0.12)', padding: '1px 6px',
            borderRadius: 4, textTransform: 'uppercase', letterSpacing: '0.5px',
          }}>
            {t('danmaku.live')}
          </span>
        )}
      </div>

      {/* Flying overlay (shows last 30 messages for visual richness) */}
      <div style={{
        borderRadius: 8, overflow: 'hidden',
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid #38383a',
        marginBottom: 8,
      }}>
        <DanmakuOverlay messages={allMessages.slice(-30)} />
      </div>

      {/* Input (during live window or before any danmaku sent) */}
      {canSend ? (
        <DanmakuInput onSend={send} connected={connected} />
      ) : (
        <p style={{ fontSize: 12, color: 'rgba(235,235,245,0.30)', textAlign: 'center', padding: '4px 0' }}>
          {t('danmaku.windowClosed')}
        </p>
      )}
    </div>
  )
}

/**
 * PlayerHudFrame — HUD chrome wrapper around <VideoPlayer/>.
 *
 * The video engine itself (artplayer) lives inside <VideoPlayer/> untouched.
 * This component wraps it with:
 *   - a status strip ABOVE   ("STREAM / N comments / quality")
 *   - 4 corner brackets on the player frame
 *   - a thin horizontal ChapterBar BELOW (visual progress identity)
 *   - a callsign in lower-right ("// EP NN //")
 *
 * Motion (respects prefers-reduced-motion):
 *   #11 status-strip type-on effect (chars appear sequentially) on mount
 *   #3  CornerBrackets stagger fade-in (delegated to the primitive)
 *   #1  ChapterBar scaleX entrance (delegated to the primitive)
 *
 * The frame is purely chrome — no playback callbacks, no engine state. The
 * `progressKey` prop is forwarded to <VideoPlayer/> as before; the chrome
 * does not introspect playback time.
 */

import { useEffect, useState } from 'react'
import { motion as Motion, useReducedMotion } from 'motion/react'
import VideoPlayer from './VideoPlayer'
import { CornerBrackets } from '../shared/hud'
import { mono, PLAYER_HUE } from '../shared/hud-tokens'

const HUE = PLAYER_HUE.stream
const HUE_LIVE = PLAYER_HUE.live

const s = {
  frame: {
    position: 'relative',
    padding: '12px 8px',
  },
  statusStrip: {
    ...mono,
    fontSize: 11,
    color: 'rgba(235,235,245,0.45)',
    textTransform: 'uppercase',
    letterSpacing: '0.14em',
    padding: '8px 14px',
    marginBottom: 8,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 16,
    borderTop: `1px solid oklch(46% 0.06 ${HUE} / 0.36)`,
    borderBottom: `1px solid oklch(46% 0.06 ${HUE} / 0.36)`,
  },
  statusLeft: { display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', minWidth: 0 },
  statusRight: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
  liveDot: {
    width: 6, height: 6, borderRadius: 9999,
    background: `oklch(62% 0.19 ${HUE_LIVE})`,
    boxShadow: `0 0 12px oklch(62% 0.19 ${HUE_LIVE} / 0.6)`,
    display: 'inline-block',
  },
  playerSlot: {
    position: 'relative',
  },
  callsign: {
    ...mono,
    position: 'absolute',
    bottom: 6,
    right: 14,
    fontSize: 10,
    color: 'rgba(235,235,245,0.30)',
    textTransform: 'uppercase',
    letterSpacing: '0.16em',
    pointerEvents: 'none',
    zIndex: 2,
  },
}

/**
 * useTypeOn — Motion #11: render `text` letter-by-letter on mount.
 * Reduced-motion users get the full string instantly.
 */
function useTypeOn(text, charIntervalMs = 18) {
  const reduced = useReducedMotion()
  const [count, setCount] = useState(reduced ? text.length : 0)

  useEffect(() => {
    if (reduced) {
      setCount(text.length)
      return
    }
    setCount(0)
    let i = 0
    const id = window.setInterval(() => {
      i += 1
      setCount(i)
      if (i >= text.length) window.clearInterval(id)
    }, charIntervalMs)
    return () => window.clearInterval(id)
  }, [text, charIntervalMs, reduced])

  return text.slice(0, count)
}

export default function PlayerHudFrame({
  videoUrl,
  danmakuList,
  subtitleUrl,
  onEnded,
  progressKey,
  episode,
  danmakuCount = 0,
  quality = 'AUTO',
  resumeAt = null,
  onProgressTick,
}) {
  const statusText = `STREAM // ${danmakuCount} COMMENTS // ${quality}`
  const typed = useTypeOn(statusText)
  const epLabel = episode != null ? String(episode).padStart(2, '0') : '--'

  return (
    <div style={s.frame}>
      {/* Status strip (Motion #11 type-on) — communicates real state, so it
          stays in the a11y tree; the live dot is the only purely decorative bit. */}
      <div style={s.statusStrip} role="status" aria-live="polite">
        <div style={s.statusLeft}>
          <span style={s.liveDot} aria-hidden />
          <span>{typed}</span>
        </div>
        <div style={s.statusRight}>
          <span>EP {epLabel}</span>
        </div>
      </div>

      {/* Player slot — corner brackets + callsign overlay */}
      <div style={s.playerSlot}>
        <CornerBrackets inset={4} size={10} opacity={0.32} />
        <VideoPlayer
          videoUrl={videoUrl}
          danmakuList={danmakuList}
          subtitleUrl={subtitleUrl}
          onEnded={onEnded}
          progressKey={progressKey}
          resumeAt={resumeAt}
          onProgressTick={onProgressTick}
        />
        <Motion.span
          style={s.callsign}
          initial={false}
          animate={{ opacity: 1 }}
          aria-hidden
        >
          // EP {epLabel} //
        </Motion.span>
      </div>
    </div>
  )
}

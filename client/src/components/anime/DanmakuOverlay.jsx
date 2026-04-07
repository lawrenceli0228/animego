import { useEffect, useState, useRef } from 'react'

const LANE_COUNT  = 4
const LANE_HEIGHT = 32  // px per lane
const FLY_DURATION = 7  // seconds to cross the container

export default function DanmakuOverlay({ messages }) {
  const [items, setItems] = useState([])
  const prevLen = useRef(0)
  // Per-instance lane tracker (fixes shared module-level state bug when
  // multiple overlays are mounted simultaneously)
  const laneLastUsed = useRef(Array(LANE_COUNT).fill(0))

  const pickLane = () => {
    const lanes = laneLastUsed.current
    const oldest = lanes.indexOf(Math.min(...lanes))
    lanes[oldest] = Date.now()
    return oldest
  }

  // When new messages arrive, animate them
  useEffect(() => {
    if (messages.length <= prevLen.current) return
    const newMsgs = messages.slice(prevLen.current)
    prevLen.current = messages.length

    setItems(prev => [
      ...prev,
      ...newMsgs.map((m) => ({
        id:    m._id ? String(m._id) : String(Math.random()),
        text:  m.content,
        lane:  pickLane(),
        color: COLORS[m.username ? m.username.charCodeAt(0) % COLORS.length : 0],
      })),
    ])
  }, [messages])

  // Clean up finished animations
  const removeItem = (id) => setItems(prev => prev.filter(i => i.id !== id))

  return (
    <div aria-hidden="true" style={{
      position: 'relative',
      width: '100%',
      height: LANE_COUNT * LANE_HEIGHT,
      overflow: 'hidden',
      pointerEvents: 'none',
      userSelect: 'none',
    }}>
      <style>{`
        @keyframes danmaku-fly {
          from { transform: translateX(110%); }
          to   { transform: translateX(-110%); }
        }
      `}</style>

      {items.map(item => (
        <div
          key={item.id}
          onAnimationEnd={() => removeItem(item.id)}
          style={{
            position: 'absolute',
            top: item.lane * LANE_HEIGHT + 4,
            right: 0,
            whiteSpace: 'nowrap',
            fontSize: 14,
            fontWeight: 700,
            color: item.color,
            textShadow: '0 1px 3px rgba(0,0,0,0.8)',
            animation: `danmaku-fly ${FLY_DURATION}s linear forwards`,
            fontFamily: "'Sora', sans-serif",
          }}
        >
          {item.text}
        </div>
      ))}
    </div>
  )
}

const COLORS = ['#0a84ff', '#5ac8fa', '#30d158', '#ff9f0a', '#409cff', '#ffffff']

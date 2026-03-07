import { STATUS_OPTIONS } from '../../utils/constants'

export default function StatusBadge({ status }) {
  const opt = STATUS_OPTIONS.find(o => o.value === status)
  if (!opt) return null
  return (
    <span style={{
      display: 'inline-block',
      padding: '3px 10px',
      borderRadius: 20,
      fontSize: 11,
      fontWeight: 600,
      color: opt.color,
      background: `${opt.color}18`,
      border: `1px solid ${opt.color}40`,
      fontFamily: "'Sora',sans-serif"
    }}>{opt.label}</span>
  )
}

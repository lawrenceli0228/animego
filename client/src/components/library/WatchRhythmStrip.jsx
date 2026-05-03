// @ts-check
import { mono } from '../shared/hud-tokens';

/** @typedef {import('../../hooks/useWatchRhythm').WatchRhythm} WatchRhythm */

const HUE = 210;

const s = {
  wrap: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    padding: '12px 16px',
    background: `oklch(14% 0.04 ${HUE} / 0.40)`,
    border: '1px solid rgba(84,84,88,0.45)',
    borderRadius: 12,
    flexWrap: 'wrap',
  },
  // §5.x — when nested into the HUD header (right of the title), drop the
  // border + bg + padding so it reads as part of the chrome instead of a
  // separate card.
  wrapCompact: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: 0,
    background: 'transparent',
    border: 'none',
    borderRadius: 0,
    flexWrap: 'wrap',
  },
  label: {
    ...mono,
    fontSize: 10,
    color: 'rgba(235,235,245,0.30)',
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
  },
  stat: {
    display: 'inline-flex',
    alignItems: 'baseline',
    gap: 6,
  },
  num: {
    ...mono,
    fontSize: 16,
    fontWeight: 600,
    color: '#fff',
    fontVariantNumeric: 'tabular-nums',
  },
  unit: {
    fontSize: 12,
    color: 'rgba(235,235,245,0.60)',
  },
  divider: {
    width: 1,
    height: 22,
    background: 'rgba(84,84,88,0.45)',
  },
  // Mini 14-day calendar — each cell is a 14×14px square. Filled cells use
  // iOS Blue at near-full chroma; empty cells dim trench. Today's cell ringed
  // in primary so the user can find "now" on the strip.
  cal: {
    display: 'inline-flex',
    gap: 3,
    alignItems: 'center',
  },
  cell: (filled, today) => ({
    width: 14,
    height: 14,
    borderRadius: 3,
    background: filled
      ? '#0a84ff'
      : `oklch(20% 0.04 ${HUE} / 0.55)`,
    border: today ? '1px solid #5ac8fa' : '1px solid transparent',
    boxShadow: filled ? '0 0 6px rgba(10,132,255,0.45)' : 'none',
    flexShrink: 0,
  }),
  empty: {
    ...mono,
    fontSize: 11,
    color: 'rgba(235,235,245,0.40)',
    letterSpacing: '0.05em',
  },
};

/**
 * WatchRhythmStrip — slim under-header band: 本周 N 集 · 连续 X 天 · 14d cal.
 *
 * Hides itself when the user has zero progress in the last 14 days — keeps
 * fresh installs from being shouted at by an empty rhythm widget.
 *
 * §5.x library redesign: passing `compact` drops the border / background /
 * padding so the strip nests inside the HUD header without looking like a
 * separate widget pinned below.
 *
 * @param {{ rhythm: WatchRhythm, compact?: boolean }} props
 */
export default function WatchRhythmStrip({ rhythm, compact = false }) {
  // Fresh install / no recent activity → don't render. We also wait until the
  // one-shot fetch resolves; rendering a "0 集" strip during the read window
  // looks broken when we know the answer is coming in 50ms.
  if (!rhythm.loaded) return null;
  if (rhythm.totalDays === 0) return null;

  return (
    <div
      style={compact ? s.wrapCompact : s.wrap}
      data-testid="watch-rhythm-strip"
      data-compact={compact ? 'true' : 'false'}
    >
      <span style={s.label}>// CADENCE</span>

      <div style={s.stat}>
        <span style={s.num} data-testid="rhythm-this-week">{rhythm.thisWeek}</span>
        <span style={s.unit}>集本周</span>
      </div>

      <span style={s.divider} aria-hidden />

      <div style={s.stat}>
        <span style={s.num} data-testid="rhythm-streak">{rhythm.streak}</span>
        <span style={s.unit}>{rhythm.streak === 1 ? '天连续' : '天连续'}</span>
      </div>

      <span style={s.divider} aria-hidden />

      <div style={s.cal} data-testid="rhythm-calendar" aria-label={`近 14 天: ${rhythm.totalDays} 天有记录`}>
        {rhythm.past14.map((filled, i) => (
          <span
            key={i}
            style={s.cell(filled, i === rhythm.past14.length - 1)}
            data-day-index={i}
            data-filled={filled ? 'true' : 'false'}
            aria-hidden
          />
        ))}
      </div>

      <span style={s.label}>14D</span>
    </div>
  );
}

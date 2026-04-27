import { motion as Motion, useReducedMotion } from 'motion/react';
import { CornerBrackets } from '../shared/hud';
import { mono } from '../shared/hud-tokens';

// Per-episode hue rotation — same formula as EpisodeFileList for consistency.
// Final `% 360` keeps the hue in the canonical 0–360 range; null/NaN guard
// matches EpisodeFileList so unmatched episodes render in the base hue.
const epHue = (ep) => (ep != null && Number.isFinite(ep) ? (210 + ep * 10) % 360 : 210);

const s = {
  container: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    gap: 8, padding: '20px 0', overflowX: 'auto',
    flexWrap: 'wrap',
  },
  chip: (active, hue) => ({
    position: 'relative',
    padding: '8px 14px',
    borderRadius: 2,
    border: active
      ? `1px solid oklch(62% 0.19 ${hue} / 0.65)`
      : '1px solid rgba(235,235,245,0.16)',
    background: active
      ? `oklch(62% 0.19 ${hue} / 0.18)`
      : 'transparent',
    color: active
      ? `oklch(82% 0.15 ${hue})`
      : 'rgba(235,235,245,0.60)',
    fontFamily: "'JetBrains Mono', monospace",
    letterSpacing: '0.10em',
    fontVariantNumeric: 'tabular-nums',
    fontSize: 12, fontWeight: active ? 600 : 500,
    cursor: active ? 'default' : 'pointer',
    transition: 'all 150ms cubic-bezier(0.16,1,0.3,1)',
    flexShrink: 0,
    boxShadow: active
      ? `0 0 16px oklch(62% 0.19 ${hue} / 0.35)`
      : 'none',
  }),
};

/**
 * EpisodeNav — HUD chip pagination.
 *
 * Motion (respects prefers-reduced-motion):
 *   #8 active chip glow pulse (2s loop, opacity 0.6→1.0)
 *   #9 chip stagger entrance (0.04s per chip)
 */
export default function EpisodeNav({ episodes, currentEpisode, onSelect }) {
  const reduced = useReducedMotion();

  return (
    <div style={s.container}>
      {episodes.map((ep, i) => {
        const active = ep === currentEpisode;
        const hue = epHue(ep);
        const chipMotion = reduced
          ? { initial: false }
          : {
              initial: { opacity: 0, y: 6 },
              animate: { opacity: 1, y: 0 },
              transition: { duration: 0.2, delay: 0.04 * i, ease: 'easeOut' },
            };

        return (
          <Motion.button
            key={ep}
            style={s.chip(active, hue)}
            onClick={() => !active && onSelect(ep)}
            aria-current={active ? 'true' : undefined}
            {...chipMotion}
          >
            {/* Motion #8 — active chip glow pulse via opacity loop on a layer */}
            {active && !reduced && (
              <Motion.span
                aria-hidden
                style={{
                  position: 'absolute', inset: -2, borderRadius: 2,
                  boxShadow: `0 0 24px oklch(62% 0.19 ${hue} / 0.55)`,
                  pointerEvents: 'none',
                }}
                animate={{ opacity: [0.6, 1.0, 0.6] }}
                transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
              />
            )}
            {active && (
              <CornerBrackets show inset={-3} size={6} opacity={0.45} hue={hue} animate={!reduced} />
            )}
            EP{String(ep).padStart(2, '0')}
          </Motion.button>
        );
      })}
    </div>
  );
}

// @ts-check
import { useEffect } from 'react';
import { useReducedMotion } from 'motion/react';
import { PLAYER_HUE } from '../shared/hud-tokens';

const HUE = PLAYER_HUE.local;

// Module-level guard mirrors SeriesCard.jsx — inject the shimmer keyframes
// once into document.head so we don't churn 100 identical <style> tags when
// rendering a skeleton grid + 2 skeleton rows.
let __skeletonStylesInjected = false;
function ensureSkeletonStyles() {
  if (__skeletonStylesInjected || typeof document === 'undefined') return;
  __skeletonStylesInjected = true;
  const el = document.createElement('style');
  el.dataset.injectedBy = 'series-card-skeleton';
  el.textContent = `
    @keyframes seriesCardShimmer {
      0%   { transform: translateX(-100%); }
      100% { transform: translateX(100%); }
    }
    [data-skeleton-shimmer="true"] {
      animation: seriesCardShimmer 1.8s linear infinite;
    }
    @media (prefers-reduced-motion: reduce) {
      [data-skeleton-shimmer="true"] { animation: none; }
    }
  `;
  document.head.appendChild(el);
}

const s = {
  card: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    background: `oklch(14% 0.04 ${HUE} / 0.45)`,
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.20)`,
    borderRadius: 4,
    overflow: 'hidden',
    width: '100%',
  },
  cardCompact: {
    width: 140,
    flexShrink: 0,
    scrollSnapAlign: 'start',
  },
  poster: {
    width: '100%',
    aspectRatio: '2/3',
    background: `oklch(18% 0.06 ${HUE} / 0.55)`,
    position: 'relative',
    overflow: 'hidden',
  },
  shimmer: {
    position: 'absolute',
    inset: 0,
    background: `linear-gradient(110deg, transparent 30%, oklch(46% 0.06 ${HUE} / 0.22) 50%, transparent 70%)`,
    pointerEvents: 'none',
  },
  body: {
    padding: '10px 12px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  bodyCompact: {
    padding: '8px 10px 10px',
  },
  bar: (w, h = 10) => ({
    height: h,
    width: w,
    borderRadius: 3,
    background: `oklch(22% 0.05 ${HUE} / 0.65)`,
  }),
};

/**
 * SeriesCardSkeleton — placeholder card matching SeriesCard's footprint.
 * Used during the brief window before `availabilityBySeries` resolves so the
 * library page doesn't flash offline cards as accessible.
 *
 * `compact`: matches SeriesCard's compact prop (140px fixed width, single
 * title bar, no meta).
 *
 * Animation: transform-only shimmer (translateX) for a 1.8s cycle. Skipped
 * under `prefers-reduced-motion`.
 *
 * @param {{ compact?: boolean }} props
 */
export default function SeriesCardSkeleton({ compact = false }) {
  const reduced = useReducedMotion();
  useEffect(() => { ensureSkeletonStyles(); }, []);

  return (
    <div
      style={{ ...s.card, ...(compact ? s.cardCompact : null) }}
      data-testid="series-card-skeleton"
      data-compact={compact ? 'true' : 'false'}
      aria-hidden
    >
      <div style={s.poster}>
        <div style={s.shimmer} data-skeleton-shimmer={reduced ? 'false' : 'true'} />
      </div>
      <div style={{ ...s.body, ...(compact ? s.bodyCompact : null) }}>
        <div style={s.bar(compact ? '80%' : '72%', compact ? 9 : 11)} />
        {!compact && <div style={s.bar('44%', 9)} />}
      </div>
    </div>
  );
}

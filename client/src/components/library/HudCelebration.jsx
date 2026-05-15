// @ts-check
import { useEffect, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { mono, PLAYER_HUE, LOCAL_HEX_GLYPH } from '../shared/hud-tokens';

const HUE = PLAYER_HUE.local;

const s = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: `oklch(8% 0.02 ${HUE} / 0.78)`,
    backdropFilter: 'blur(6px)',
    WebkitBackdropFilter: 'blur(6px)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 18,
    zIndex: 1000,
    cursor: 'pointer',
  },
  title: {
    ...mono,
    fontSize: 'clamp(20px, 2.5vw, 30px)',
    letterSpacing: '0.16em',
    color: `oklch(78% 0.16 ${HUE})`,
    textTransform: 'uppercase',
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    textShadow: `0 0 22px oklch(72% 0.18 ${HUE} / 0.45)`,
    pointerEvents: 'none',
  },
  readout: {
    ...mono,
    fontSize: 13,
    letterSpacing: '0.10em',
    color: 'rgba(235,235,245,0.65)',
    textTransform: 'uppercase',
    display: 'flex',
    gap: 14,
    alignItems: 'center',
    flexWrap: 'wrap',
    justifyContent: 'center',
    pointerEvents: 'none',
  },
  num: { color: '#fff', fontWeight: 600 },
  dot: { color: 'rgba(235,235,245,0.30)' },
  // Decorative HUD frame: large corner brackets centered around the readout.
  frame: {
    position: 'absolute',
    width: 'min(64vw, 720px)',
    height: 'min(36vh, 280px)',
    pointerEvents: 'none',
    color: `oklch(72% 0.16 ${HUE} / 0.45)`,
  },
  corner: (pos) => {
    const sz = 28;
    // Fold color into each `border<Side>` shorthand instead of pairing them
    // with a separate `borderColor` shorthand — React's rerender diff trips
    // on mixed shorthand/longhand for the same logical property.
    const base = { position: 'absolute', width: sz, height: sz };
    const stroke = '1px solid currentColor';
    if (pos === 'tl') return { ...base, top: 0, left: 0, borderTop: stroke, borderLeft: stroke };
    if (pos === 'tr') return { ...base, top: 0, right: 0, borderTop: stroke, borderRight: stroke };
    if (pos === 'bl') return { ...base, bottom: 0, left: 0, borderBottom: stroke, borderLeft: stroke };
    return { ...base, bottom: 0, right: 0, borderBottom: stroke, borderRight: stroke };
  },
};

/**
 * Format a byte count into a short readable string (B / KB / MB / GB / TB).
 * @param {number} bytes
 */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

/**
 * HudCelebration — full-screen HUD readout fired once per import completion.
 *
 * Animation budget: 220ms fade-in, ~900ms hold, 220ms fade-out (≈1.4s total).
 * Click anywhere to skip. Reduced-motion users skip the overlay entirely
 * (still calls onComplete so the parent can clear its trigger key).
 *
 * Implements Q2 design decision B (ceremonial readout for the first-import
 * milestone). Source: ~/.gstack/projects/lawrenceli0228-animego/designs/
 * library-decisions-20260503/q2.html
 *
 * @param {{
 *   triggerKey: number | string | null,
 *   seriesCount: number,
 *   episodeCount: number,
 *   bytesIndexed?: number,
 *   onComplete?: () => void,
 * }} props
 */
export default function HudCelebration({
  triggerKey,
  seriesCount,
  episodeCount,
  bytesIndexed,
  onComplete,
}) {
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (triggerKey == null) return undefined;
    if (reduced) {
      onComplete?.();
      return undefined;
    }
    setOpen(true);
    const timer = setTimeout(() => {
      setOpen(false);
    }, 1200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggerKey, reduced]);

  if (reduced) return null;

  function handleSkip() {
    setOpen(false);
  }

  return (
    <AnimatePresence onExitComplete={() => onComplete?.()}>
      {open && (
        <motion.div
          style={s.overlay}
          data-testid="hud-celebration"
          role="status"
          aria-live="polite"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          onClick={handleSkip}
        >
          <div style={s.frame} aria-hidden>
            <span style={s.corner('tl')} />
            <span style={s.corner('tr')} />
            <span style={s.corner('bl')} />
            <span style={s.corner('br')} />
          </div>
          <motion.div
            style={s.title}
            initial={{ y: 10, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 6, opacity: 0 }}
            transition={{ duration: 0.32, delay: 0.06, ease: [0.16, 1, 0.3, 1] }}
          >
            <span aria-hidden>{`// LIBRARY READY ${LOCAL_HEX_GLYPH} //`}</span>
          </motion.div>
          <motion.div
            style={s.readout}
            initial={{ y: 10, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 6, opacity: 0 }}
            transition={{ duration: 0.32, delay: 0.14, ease: [0.16, 1, 0.3, 1] }}
            data-testid="hud-celebration-readout"
          >
            <span>
              <span style={s.num}>{seriesCount}</span>
              <span>&nbsp;SERIES</span>
            </span>
            <span style={s.dot}>·</span>
            <span>
              <span style={s.num}>{episodeCount}</span>
              <span>&nbsp;EPISODES</span>
            </span>
            {bytesIndexed != null && bytesIndexed > 0 && (
              <>
                <span style={s.dot}>·</span>
                <span>
                  <span style={s.num}>{formatBytes(bytesIndexed)}</span>
                  <span>&nbsp;INDEXED</span>
                </span>
              </>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

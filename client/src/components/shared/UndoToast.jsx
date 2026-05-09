// @ts-check
import { useEffect, useRef, useState, useCallback } from 'react';
import { mono, PLAYER_HUE, LOCAL_BADGE_COLOR, LOCAL_HEX_GLYPH } from './hud-tokens';

const HUE = PLAYER_HUE.local;

const s = {
  region: {
    position: 'fixed',
    left: '50%',
    bottom: 24,
    transform: 'translateX(-50%)',
    zIndex: 9000,
    pointerEvents: 'none',
  },
  toast: {
    pointerEvents: 'auto',
    minWidth: 320,
    maxWidth: 'min(560px, 92vw)',
    display: 'flex',
    alignItems: 'stretch',
    gap: 12,
    padding: '12px 14px',
    background: 'oklch(14% 0.04 210 / 0.92)',
    border: `1px solid ${LOCAL_BADGE_COLOR}55`,
    borderRadius: 6,
    boxShadow: '0 8px 24px oklch(2% 0 0 / 0.55)',
    backdropFilter: 'blur(10px)',
    WebkitBackdropFilter: 'blur(10px)',
    color: '#fff',
  },
  glyphCol: {
    display: 'flex',
    alignItems: 'flex-start',
    paddingTop: 2,
  },
  glyph: {
    ...mono,
    fontSize: 14,
    color: LOCAL_BADGE_COLOR,
  },
  body: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  kicker: {
    ...mono,
    fontSize: 9,
    color: LOCAL_BADGE_COLOR,
    textTransform: 'uppercase',
    letterSpacing: '0.18em',
  },
  title: {
    fontFamily: "'Sora', sans-serif",
    fontWeight: 600,
    fontSize: 13,
    lineHeight: 1.3,
    color: '#fff',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  meta: {
    ...mono,
    fontSize: 10,
    color: 'rgba(235,235,245,0.55)',
    letterSpacing: '0.04em',
  },
  actions: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    justifyContent: 'center',
    gap: 4,
  },
  btn: {
    ...mono,
    background: 'transparent',
    border: `1px solid oklch(62% 0.17 ${HUE} / 0.55)`,
    color: `oklch(78% 0.14 ${HUE})`,
    padding: '5px 10px',
    borderRadius: 3,
    cursor: 'pointer',
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: '0.12em',
    minWidth: 64,
  },
  btnGhost: {
    ...mono,
    background: 'transparent',
    border: `1px solid rgba(235,235,245,0.18)`,
    color: 'rgba(235,235,245,0.65)',
    padding: '5px 10px',
    borderRadius: 3,
    cursor: 'pointer',
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: '0.12em',
    minWidth: 64,
  },
  countdownTrack: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 2,
    background: 'rgba(255,255,255,0.06)',
    borderRadius: '0 0 6px 6px',
    overflow: 'hidden',
  },
  countdownFill: (pct) => ({
    height: '100%',
    width: `${pct * 100}%`,
    background: LOCAL_BADGE_COLOR,
    transition: 'width 80ms linear',
  }),
};

/**
 * UndoToast — 5s auto-dismiss toast with hover-pause and an [撤销] action.
 *
 * §5.6 contract:
 *   - 5s timer (Material lower bound) starts from mount,
 *   - hovering or focusing inside the toast PAUSES the timer,
 *   - [撤销] fires `onUndo` and the toast self-dismisses (button hidden when
 *     `onUndo` is not provided — used for auto-merge info-only toasts where
 *     undo would mean splitting back, which is a separate op),
 *   - [查看] (when `onView` provided) is a soft link; the toast still dismisses,
 *   - timer expiry calls `onDismiss` exactly once.
 *
 * The toast renders inside an `aria-live="polite"` region for AT.
 *
 * @param {{
 *   open: boolean,
 *   title: string,
 *   meta?: string,
 *   kicker?: string,
 *   undoLabel?: string,
 *   viewLabel?: string,
 *   onUndo?: () => void,
 *   onDismiss: () => void,
 *   onView?: () => void,
 *   durationMs?: number,
 *   testId?: string,
 * }} props
 */
export default function UndoToast({
  open,
  title,
  meta,
  kicker = '已合并',
  undoLabel = '撤销',
  viewLabel = '查看',
  onUndo,
  onDismiss,
  onView,
  durationMs = 5000,
  testId = 'undo-toast',
}) {
  const [remaining, setRemaining] = useState(durationMs);
  const [paused, setPaused] = useState(false);
  const remainingRef = useRef(durationMs);
  const lastTickRef = useRef(0);
  const pausedRef = useRef(false);
  const rafRef = useRef(/** @type {number|null} */ (null));
  const dismissedRef = useRef(false);

  const dismiss = useCallback(() => {
    if (dismissedRef.current) return;
    dismissedRef.current = true;
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    onDismiss();
  }, [onDismiss]);

  useEffect(() => {
    if (!open) return undefined;
    dismissedRef.current = false;
    remainingRef.current = durationMs;
    setRemaining(durationMs);
    lastTickRef.current = performance.now();
    pausedRef.current = false;

    const tick = (t) => {
      if (dismissedRef.current) return;
      if (!pausedRef.current) {
        const dt = t - lastTickRef.current;
        remainingRef.current = Math.max(0, remainingRef.current - dt);
        setRemaining(remainingRef.current);
        if (remainingRef.current <= 0) {
          dismiss();
          return;
        }
      }
      lastTickRef.current = t;
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [open, durationMs, dismiss]);

  const pause = useCallback(() => { pausedRef.current = true; setPaused(true); }, []);
  const resume = useCallback(() => {
    pausedRef.current = false;
    lastTickRef.current = performance.now();
    setPaused(false);
  }, []);

  const handleUndo = useCallback(() => {
    if (dismissedRef.current) return;
    if (!onUndo) return;
    onUndo();
    dismiss();
  }, [onUndo, dismiss]);

  const handleView = useCallback(() => {
    if (dismissedRef.current) return;
    if (onView) onView();
    dismiss();
  }, [onView, dismiss]);

  if (!open) return null;

  const pct = Math.max(0, Math.min(1, remaining / durationMs));

  return (
    <div
      style={s.region}
      role="status"
      aria-live="polite"
      data-testid={`${testId}-region`}
    >
      <div
        data-testid={testId}
        data-paused={paused ? 'true' : 'false'}
        style={{ ...s.toast, position: 'relative' }}
        onMouseEnter={pause}
        onMouseLeave={resume}
        onFocus={pause}
        onBlur={resume}
      >
        <div style={s.glyphCol} aria-hidden>
          <span style={s.glyph}>{LOCAL_HEX_GLYPH}</span>
        </div>
        <div style={s.body}>
          <span style={s.kicker}>{kicker}</span>
          <span style={s.title} data-testid={`${testId}-title`}>{title}</span>
          {meta && <span style={s.meta} data-testid={`${testId}-meta`}>{meta}</span>}
        </div>
        <div style={s.actions}>
          {onUndo && (
            <button
              type="button"
              data-testid={`${testId}-undo`}
              style={s.btn}
              onClick={handleUndo}
            >
              {undoLabel}
            </button>
          )}
          {onView && (
            <button
              type="button"
              data-testid={`${testId}-view`}
              style={s.btnGhost}
              onClick={handleView}
            >
              {viewLabel}
            </button>
          )}
        </div>
        <div style={s.countdownTrack} aria-hidden>
          <div style={s.countdownFill(pct)} data-testid={`${testId}-countdown`} />
        </div>
      </div>
    </div>
  );
}

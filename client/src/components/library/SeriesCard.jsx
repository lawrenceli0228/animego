// @ts-check
import { useState, useRef, useEffect, useCallback } from 'react';
import {
  mono,
  PLAYER_HUE,
  LOCAL_BADGE_COLOR,
  LOCAL_HEX_GLYPH,
  PROGRESS_FILL,
} from '../shared/hud-tokens';
import { CornerBrackets } from '../shared/hud';

/** @typedef {import('../../lib/library/types').Series} Series */
/** @typedef {import('../../lib/library/types').UserOverride} UserOverride */
/** @typedef {'lock'|'unlock'|'clear'|'merge'|'split'|'rematch'} OverrideAction */

const HUE = PLAYER_HUE.local;
const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_TOL = 10;

const s = {
  card: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    background: `oklch(14% 0.04 ${HUE} / 0.60)`,
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.35)`,
    borderRadius: 4,
    overflow: 'hidden',
    cursor: 'pointer',
    textAlign: 'left',
    padding: 0,
    color: '#fff',
    transition: 'border-color 150ms ease-out, box-shadow 150ms ease-out',
    width: '100%',
    WebkitTouchCallout: 'none',
    WebkitUserSelect: 'none',
    userSelect: 'none',
  },
  cardSelected: {
    border: `1px solid oklch(72% 0.16 ${HUE} / 0.95)`,
    boxShadow: `0 0 0 2px oklch(72% 0.16 ${HUE} / 0.55)`,
  },
  selectMark: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 22,
    height: 22,
    borderRadius: 999,
    background: `oklch(62% 0.17 ${HUE})`,
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 13,
    fontWeight: 700,
    lineHeight: 1,
    zIndex: 3,
    boxShadow: '0 1px 3px oklch(2% 0 0 / 0.4)',
    pointerEvents: 'none',
  },
  selectMarkEmpty: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 22,
    height: 22,
    borderRadius: 999,
    background: 'oklch(8% 0 0 / 0.55)',
    border: '1.5px solid rgba(255,255,255,0.65)',
    backdropFilter: 'blur(4px)',
    WebkitBackdropFilter: 'blur(4px)',
    zIndex: 3,
    pointerEvents: 'none',
  },
  posterWrap: {
    position: 'relative',
    width: '100%',
  },
  poster: {
    width: '100%',
    aspectRatio: '2/3',
    objectFit: 'cover',
    display: 'block',
  },
  monogram: {
    width: '100%',
    aspectRatio: '2/3',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: `oklch(18% 0.06 ${HUE} / 0.80)`,
    fontFamily: "'Sora', sans-serif",
    fontSize: 28,
    fontWeight: 700,
    color: `oklch(72% 0.15 ${HUE})`,
  },
  body: {
    padding: '10px 12px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  titleRow: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 6,
  },
  title: {
    fontFamily: "'Sora', sans-serif",
    fontWeight: 600,
    fontSize: 13,
    color: '#fff',
    lineHeight: 1.3,
    flex: 1,
  },
  localBadge: {
    ...mono,
    position: 'absolute',
    top: 8,
    left: 8,
    height: 20,
    padding: '0 8px 0 6px',
    background: 'rgba(28, 28, 30, 0.75)',
    border: `1px solid ${LOCAL_BADGE_COLOR}4D`,
    color: LOCAL_BADGE_COLOR,
    borderRadius: 999,
    fontSize: 9,
    fontWeight: 500,
    textTransform: 'uppercase',
    letterSpacing: '0.10em',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    zIndex: 2,
  },
  localGlyph: {
    fontSize: 11,
    lineHeight: 1,
  },
  lockedBadge: {
    ...mono,
    fontSize: 9,
    padding: '2px 5px',
    background: `oklch(62% 0.17 60 / 0.20)`,
    border: `1px solid oklch(62% 0.17 60 / 0.45)`,
    color: `oklch(75% 0.15 60)`,
    borderRadius: 2,
    textTransform: 'uppercase',
    letterSpacing: '0.12em',
    flexShrink: 0,
    alignSelf: 'flex-start',
    marginTop: 1,
  },
  epCount: {
    ...mono,
    fontSize: 11,
    color: `rgba(235,235,245,0.45)`,
  },
  duration: {
    ...mono,
    fontSize: 10,
    color: 'rgba(235,235,245,0.45)',
    fontVariantNumeric: 'tabular-nums',
    letterSpacing: '0.05em',
  },
  progressOverlay: {
    position: 'absolute',
    left: 10,
    right: 10,
    bottom: 10,
    height: 3,
    background: 'rgba(255,255,255,0.12)',
    borderRadius: 999,
    overflow: 'hidden',
    zIndex: 2,
  },
  progressFill: (pct) => ({
    height: '100%',
    width: `${Math.max(0, Math.min(1, pct)) * 100}%`,
    background: PROGRESS_FILL,
    borderRadius: 999,
    boxShadow: `0 0 6px ${PROGRESS_FILL}66`,
  }),
  kebab: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 24,
    height: 24,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'oklch(8% 0 0 / 0.65)',
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.40)`,
    borderRadius: 3,
    color: 'rgba(255,255,255,0.85)',
    cursor: 'pointer',
    fontSize: 14,
    lineHeight: 1,
    padding: 0,
    zIndex: 2,
  },
  menu: {
    position: 'absolute',
    top: 32,
    right: 6,
    minWidth: 140,
    background: `oklch(12% 0.03 ${HUE} / 0.95)`,
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.55)`,
    borderRadius: 3,
    boxShadow: '0 4px 16px oklch(2% 0 0 / 0.5)',
    padding: '4px 0',
    zIndex: 10,
    backdropFilter: 'blur(6px)',
    WebkitBackdropFilter: 'blur(6px)',
  },
  menuItem: {
    ...mono,
    display: 'block',
    width: '100%',
    padding: '8px 12px',
    background: 'transparent',
    border: 'none',
    color: 'rgba(235,235,245,0.92)',
    textAlign: 'left',
    fontSize: 11,
    cursor: 'pointer',
    letterSpacing: '0.05em',
  },
};

/**
 * SeriesCard — single series tile in the library grid (§5.4 / §5.6).
 *
 * Layout:
 *   - Poster overlay: ⬡ LOCAL badge top-left (teal #5ac8fa), iOS Blue progress
 *     bar at the bottom when `progressPct` is supplied.
 *   - Body: title (with optional LOCK badge), episode count, optional
 *     `durationLabel` rendered in mono 10px tertiary.
 *
 * Selection (§5.6): when `selectionMode` is true the card click toggles
 * selection instead of navigating, the kebab is hidden, and a circular mark
 * appears top-right (filled stream-hue when `selected`, empty ring otherwise).
 * A 500ms long-press anywhere on the card fires `onLongPress` so the page can
 * enter selection mode. The click that follows the long-press is suppressed so
 * we don't both pick and navigate from the same gesture.
 *
 * The kebab menu is opt-in: omit `onOverrideAction` and the kebab disappears
 * (callers that don't need menu actions stay simple). The card stays
 * navigation-clickable while the kebab and menu stop event propagation so
 * they never trigger the card's own onClick.
 *
 * @param {{
 *   series: Series,
 *   lastPlayedEp?: number,
 *   progressPct?: number,
 *   durationLabel?: string,
 *   onClick: (e?: import('react').MouseEvent) => void,
 *   override?: UserOverride,
 *   onOverrideAction?: (action: OverrideAction) => void,
 *   selectionMode?: boolean,
 *   selected?: boolean,
 *   onToggleSelect?: (e?: import('react').MouseEvent) => void,
 *   onLongPress?: () => void,
 * }} props
 */
export default function SeriesCard({
  series,
  progressPct,
  durationLabel,
  onClick,
  override,
  onOverrideAction,
  selectionMode = false,
  selected = false,
  onToggleSelect,
  onLongPress,
}) {
  const title = series.titleEn || series.titleZh || series.titleJa || series.id;
  const initial = title.charAt(0).toUpperCase();
  // Whitelist https only — IDB-stored values may be attacker-influenced via
  // crafted matchCache entries or future enrichment paths.
  const safePoster = typeof series.posterUrl === 'string' && /^https:\/\//i.test(series.posterUrl)
    ? series.posterUrl
    : null;

  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef(/** @type {HTMLDivElement|null} */ (null));
  const longPressTimerRef = useRef(/** @type {ReturnType<typeof setTimeout>|null} */ (null));
  const longPressFiredRef = useRef(false);
  const pointerStartRef = useRef(/** @type {{x:number,y:number}|null} */ (null));

  useEffect(() => {
    if (!menuOpen) return undefined;
    function handleOutside(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [menuOpen]);

  function fire(action) {
    setMenuOpen(false);
    if (onOverrideAction) onOverrideAction(action);
  }

  const cancelLongPress = useCallback(() => {
    if (longPressTimerRef.current != null) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    pointerStartRef.current = null;
  }, []);

  const handlePointerDown = useCallback((e) => {
    longPressFiredRef.current = false;
    if (!onLongPress) return;
    pointerStartRef.current = { x: e.clientX, y: e.clientY };
    longPressTimerRef.current = setTimeout(() => {
      longPressFiredRef.current = true;
      longPressTimerRef.current = null;
      onLongPress();
    }, LONG_PRESS_MS);
  }, [onLongPress]);

  const handlePointerMove = useCallback((e) => {
    const start = pointerStartRef.current;
    if (!start || longPressTimerRef.current == null) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (dx * dx + dy * dy > LONG_PRESS_MOVE_TOL * LONG_PRESS_MOVE_TOL) {
      cancelLongPress();
    }
  }, [cancelLongPress]);

  useEffect(() => () => cancelLongPress(), [cancelLongPress]);

  const handleCardClick = useCallback((e) => {
    if (longPressFiredRef.current) {
      longPressFiredRef.current = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (selectionMode) {
      if (onToggleSelect) onToggleSelect(e);
      return;
    }
    if (onClick) onClick(e);
  }, [selectionMode, onToggleSelect, onClick]);

  const isLocked = override?.locked === true;
  const hasOverride = override != null;
  const cardStyle = selected ? { ...s.card, ...s.cardSelected } : s.card;
  const showKebab = !!onOverrideAction && !selectionMode;

  return (
    <div ref={rootRef} style={{ position: 'relative' }} data-testid="series-card-root">
      <button
        style={cardStyle}
        onClick={handleCardClick}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={cancelLongPress}
        onPointerCancel={cancelLongPress}
        onPointerLeave={cancelLongPress}
        type="button"
        role="button"
        aria-pressed={selectionMode ? selected : undefined}
        data-selected={selected ? 'true' : 'false'}
        data-selection-mode={selectionMode ? 'true' : 'false'}
      >
        <CornerBrackets inset={4} size={8} opacity={0.25} hue={HUE} />

        <div style={s.posterWrap}>
          {safePoster ? (
            <img src={safePoster} alt={title} style={s.poster} />
          ) : (
            <div style={s.monogram} data-testid="monogram" aria-hidden>
              {initial}
            </div>
          )}
          <span style={s.localBadge} data-testid="local-badge">
            <span aria-hidden style={s.localGlyph}>{LOCAL_HEX_GLYPH}</span>
            LOCAL
          </span>
          {progressPct != null && (
            <div style={s.progressOverlay} data-testid="progress-bar">
              <div style={s.progressFill(progressPct)} />
            </div>
          )}
        </div>

        <div style={s.body}>
          <div style={s.titleRow}>
            <span style={s.title}>{title}</span>
            {isLocked && (
              <span style={s.lockedBadge} data-testid="locked-badge">LOCK</span>
            )}
          </div>
          {series.totalEpisodes != null && (
            <span style={s.epCount}>{series.totalEpisodes}</span>
          )}
          {durationLabel && (
            <span style={s.duration} data-testid="duration-label">
              {durationLabel}
            </span>
          )}
        </div>
      </button>

      {selectionMode && (
        selected ? (
          <span
            data-testid="series-select-mark"
            data-selected="true"
            style={s.selectMark}
            aria-hidden
          >
            ✓
          </span>
        ) : (
          <span
            data-testid="series-select-mark"
            data-selected="false"
            style={s.selectMarkEmpty}
            aria-hidden
          />
        )
      )}

      {showKebab && (
        <button
          type="button"
          data-testid="series-kebab"
          aria-label="操作菜单"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            setMenuOpen((v) => !v);
          }}
          style={s.kebab}
        >
          ⋯
        </button>
      )}

      {menuOpen && showKebab && (
        <div
          role="menu"
          data-testid="series-menu"
          style={s.menu}
          onClick={(e) => e.stopPropagation()}
        >
          {isLocked ? (
            <button
              type="button"
              role="menuitem"
              data-testid="menu-unlock"
              style={s.menuItem}
              onClick={() => fire('unlock')}
            >
              解锁匹配
            </button>
          ) : (
            <button
              type="button"
              role="menuitem"
              data-testid="menu-lock"
              style={s.menuItem}
              onClick={() => fire('lock')}
            >
              锁定匹配
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            data-testid="menu-merge"
            style={s.menuItem}
            onClick={() => fire('merge')}
          >
            合并到…
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="menu-split"
            style={s.menuItem}
            onClick={() => fire('split')}
          >
            拆分…
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="menu-rematch"
            style={s.menuItem}
            onClick={() => fire('rematch')}
          >
            重新匹配…
          </button>
          {hasOverride && (
            <button
              type="button"
              role="menuitem"
              data-testid="menu-clear"
              style={s.menuItem}
              onClick={() => fire('clear')}
            >
              清除覆盖
            </button>
          )}
        </div>
      )}
    </div>
  );
}

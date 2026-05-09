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

// Module-level guard: §5.x cinematic hover / focus styles inject once into
// document.head. Inline-style React doesn't reach :hover or :focus-visible,
// so a single global stylesheet handles those — without :focus-visible we'd
// flash the ring on every mouse click, and without `(hover: hover)` we'd
// scale on touch devices when the press should be flat.
let __seriesCardStylesInjected = false;
function ensureSeriesCardStyles() {
  if (__seriesCardStylesInjected || typeof document === 'undefined') return;
  __seriesCardStylesInjected = true;
  const el = document.createElement('style');
  el.dataset.injectedBy = 'series-card';
  el.textContent = `
    [data-series-card-button="true"] {
      transition:
        transform 220ms cubic-bezier(0.16,1,0.3,1),
        box-shadow 220ms ease-out,
        border-color 180ms ease-out;
    }
    @media (hover: hover) {
      [data-series-card-button="true"]:hover:not([data-selection-mode="true"]):not([disabled]) {
        transform: translateY(-2px) scale(1.02);
        box-shadow:
          0 10px 28px oklch(2% 0 0 / 0.50),
          0 0 0 1px oklch(62% 0.17 210 / 0.55);
      }
      [data-series-card-button="true"]:hover:not([data-selection-mode="true"]) [data-poster-scrim="true"] {
        opacity: 1;
      }
    }
    [data-series-card-button="true"]:focus-visible {
      outline: 2px solid oklch(72% 0.16 210 / 0.85);
      outline-offset: 2px;
    }
    [data-series-card-button="true"]:focus:not(:focus-visible) {
      outline: none;
    }
    @media (prefers-reduced-motion: reduce) {
      [data-series-card-button="true"] {
        transition: border-color 180ms ease-out;
      }
      [data-series-card-button="true"]:hover {
        transform: none !important;
        box-shadow: 0 0 0 1px oklch(62% 0.17 210 / 0.55) !important;
      }
    }
  `;
  document.head.appendChild(el);
}

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
  // §5.x cinematic depth — a soft bottom scrim that's mostly invisible at
  // rest (0.55 opacity) and deepens to 1.0 on hover. Always present so
  // posters with light frames don't lose their lower edge against the dark
  // card background. Sits below every text/badge layer (zIndex 1).
  posterScrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '40%',
    background: `linear-gradient(to top, oklch(8% 0.04 ${HUE} / 0.85) 0%, oklch(8% 0.04 ${HUE} / 0.15) 65%, transparent 100%)`,
    pointerEvents: 'none',
    zIndex: 1,
    opacity: 0.55,
    transition: 'opacity 220ms ease-out',
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
    // Clamp to 2 lines and reserve that space — short titles still occupy
    // two-line height so cards in the same grid row stay flush.
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    minHeight: 'calc(1.3em * 2)',
    wordBreak: 'break-word',
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
  // Offline / partial drive availability badge — sits below LOCAL on the
  // poster. OKLCH amber for partial (some files reachable), red for offline
  // (whole drive missing). Sibling to localBadge, not stacked, so it never
  // covers progressOverlay or kebab.
  availBadge: (kind) => ({
    ...mono,
    position: 'absolute',
    top: 32,
    left: 8,
    height: 20,
    padding: '0 8px',
    background: 'rgba(28,28,30,0.78)',
    border: kind === 'offline'
      ? '1px solid oklch(60% 0.20 25 / 0.55)'
      : '1px solid oklch(72% 0.16 70 / 0.55)',
    color: kind === 'offline' ? 'oklch(78% 0.18 25)' : 'oklch(82% 0.16 70)',
    borderRadius: 999,
    fontSize: 9,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.10em',
    display: 'inline-flex',
    alignItems: 'center',
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    zIndex: 2,
  }),
  cardDimmed: {
    filter: 'saturate(0.6) brightness(0.85)',
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
  metaRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 11,
    color: 'rgba(235,235,245,0.60)',
    marginTop: 2,
  },
  metaDot: {
    color: 'rgba(235,235,245,0.18)',
  },
  metaType: {
    ...mono,
    fontSize: 10,
    letterSpacing: '0.10em',
    textTransform: 'uppercase',
    color: 'rgba(235,235,245,0.55)',
  },
  metaEpUnit: {
    color: 'rgba(235,235,245,0.45)',
    fontSize: 11,
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
  // §5.4 progress count overlay — sits beside the bar at bottom-left of the
  // poster. Mono digits (e.g. `7/28`), green-toned for ✓ done, accent-toned
  // for the NEW label. Design-spec text-shadow keeps it legible over any cover.
  progressText: {
    ...mono,
    position: 'absolute',
    left: 12,
    bottom: 16,
    fontSize: 10,
    color: '#fff',
    letterSpacing: '0.05em',
    textShadow: '0 1px 4px rgba(0,0,0,0.85)',
    fontVariantNumeric: 'tabular-nums',
    pointerEvents: 'none',
    zIndex: 3,
  },
  progressTextDone: { color: '#30d158' },
  progressTextNew: {
    fontSize: 9,
    color: PROGRESS_FILL,
    letterSpacing: '0.18em',
    textTransform: 'uppercase',
    bottom: 14,
  },
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
  menuItemDanger: {
    ...mono,
    display: 'block',
    width: '100%',
    padding: '8px 12px',
    background: 'transparent',
    border: 'none',
    borderTop: '1px solid rgba(84,84,88,0.45)',
    color: 'oklch(72% 0.18 25)',
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
 *   progressLabel?: string,
 *   isNew?: boolean,
 *   durationLabel?: string,
 *   onClick: (e?: import('react').MouseEvent) => void,
 *   override?: UserOverride,
 *   onOverrideAction?: (action: OverrideAction) => void,
 *   selectionMode?: boolean,
 *   selected?: boolean,
 *   onToggleSelect?: (e?: import('react').MouseEvent) => void,
 *   onLongPress?: () => void,
 *   availability?: 'ok'|'partial'|'offline'|'unknown',
 *   compact?: boolean,
 * }} props
 *
 * @typedef {'lock'|'unlock'|'clear'|'merge'|'split'|'rematch'|'delete'} OverrideActionExt
 */
export default function SeriesCard({
  series,
  progressPct,
  progressLabel,
  isNew = false,
  durationLabel,
  onClick,
  override,
  onOverrideAction,
  selectionMode = false,
  selected = false,
  onToggleSelect,
  onLongPress,
  availability,
  compact = false,
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

  // Inject the §5.x hover / focus-visible stylesheet on first card mount.
  // No-op on subsequent mounts thanks to the module-level flag.
  useEffect(() => { ensureSeriesCardStyles(); }, []);

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
  const dimForAvail = availability === 'offline' || availability === 'partial';
  const cardStyle = {
    ...s.card,
    ...(selected ? s.cardSelected : null),
    ...(dimForAvail ? s.cardDimmed : null),
    ...(compact ? { width: 140, scrollSnapAlign: 'start' } : null),
  };
  const showKebab = !!onOverrideAction && !selectionMode && !compact;

  return (
    <div
      ref={rootRef}
      style={{ position: 'relative', ...(compact ? { flexShrink: 0 } : null) }}
      data-testid="series-card-root"
      data-compact={compact ? 'true' : 'false'}
    >
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
        data-series-card-button="true"
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
          <div style={s.posterScrim} data-poster-scrim="true" aria-hidden />
          <span style={s.localBadge} data-testid="local-badge">
            <span aria-hidden style={s.localGlyph}>{LOCAL_HEX_GLYPH}</span>
            LOCAL
          </span>
          {(availability === 'offline' || availability === 'partial') && (
            <span
              style={s.availBadge(availability)}
              data-testid="availability-badge"
              data-availability={availability}
              title={availability === 'offline' ? '硬盘未连接' : '部分文件不可用'}
            >
              {availability === 'offline' ? '⊘ OFFLINE' : '⚠ PARTIAL'}
            </span>
          )}
          {progressPct != null && (
            <div style={s.progressOverlay} data-testid="progress-bar">
              <div style={s.progressFill(progressPct)} />
            </div>
          )}
          {(progressLabel || isNew) && (
            <span
              style={{
                ...s.progressText,
                ...(isNew ? s.progressTextNew : null),
                ...(progressPct != null && progressPct >= 1 ? s.progressTextDone : null),
              }}
              data-testid="progress-label"
            >
              {isNew ? 'NEW' : progressLabel}
            </span>
          )}
        </div>

        {compact ? (
          <div
            style={{
              padding: '8px 10px 10px',
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            }}
          >
            <span
              style={{
                ...s.title,
                fontSize: 12,
                lineHeight: 1.25,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                display: 'block',
              }}
            >
              {title}
            </span>
          </div>
        ) : (
          <div style={s.body}>
            <div style={s.titleRow}>
              <span style={s.title}>{title}</span>
              {isLocked && (
                <span style={s.lockedBadge} data-testid="locked-badge">LOCK</span>
              )}
            </div>
            {(series.type || series.totalEpisodes != null) && (
              <div style={s.metaRow}>
                {series.type && (
                  <span style={s.metaType}>{String(series.type).toUpperCase()}</span>
                )}
                {series.type && series.totalEpisodes != null && (
                  <span style={s.metaDot}>·</span>
                )}
                {series.totalEpisodes != null && (
                  <>
                    <span style={s.epCount}>{series.totalEpisodes}</span>
                    <span style={s.metaEpUnit}>集</span>
                  </>
                )}
              </div>
            )}
            {durationLabel && (
              <span style={s.duration} data-testid="duration-label">
                {durationLabel}
              </span>
            )}
          </div>
        )}
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
          <button
            type="button"
            role="menuitem"
            data-testid="menu-delete"
            style={s.menuItemDanger}
            onClick={() => fire('delete')}
          >
            删除…
          </button>
        </div>
      )}
    </div>
  );
}

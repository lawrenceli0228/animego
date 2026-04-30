// @ts-check
import { useState, useRef, useEffect } from 'react';
import { mono, PLAYER_HUE } from '../shared/hud-tokens';
import { CornerBrackets } from '../shared/hud';

/** @typedef {import('../../lib/library/types').Series} Series */
/** @typedef {import('../../lib/library/types').UserOverride} UserOverride */
/** @typedef {'lock'|'unlock'|'clear'|'merge'|'split'} OverrideAction */

const HUE = PLAYER_HUE.stream;

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
    transition: 'border-color 150ms ease-out',
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
    fontSize: 9,
    padding: '2px 5px',
    background: `oklch(62% 0.17 ${HUE} / 0.20)`,
    border: `1px solid oklch(62% 0.17 ${HUE} / 0.45)`,
    color: `oklch(72% 0.15 ${HUE})`,
    borderRadius: 2,
    textTransform: 'uppercase',
    letterSpacing: '0.12em',
    flexShrink: 0,
    alignSelf: 'flex-start',
    marginTop: 1,
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
  progressTrack: {
    height: 2,
    background: `oklch(62% 0.17 ${HUE} / 0.20)`,
    borderRadius: 1,
    overflow: 'hidden',
    marginTop: 4,
  },
  progressFill: (pct) => ({
    height: '100%',
    width: `${Math.max(0, Math.min(1, pct)) * 100}%`,
    background: `oklch(62% 0.17 ${HUE})`,
    borderRadius: 1,
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
 * SeriesCard — single series tile in the library grid.
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
 *   onClick: () => void,
 *   override?: UserOverride,
 *   onOverrideAction?: (action: OverrideAction) => void,
 * }} props
 */
export default function SeriesCard({
  series,
  progressPct,
  onClick,
  override,
  onOverrideAction,
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

  const isLocked = override?.locked === true;
  const hasOverride = override != null;

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button style={s.card} onClick={onClick} type="button" role="button">
        <CornerBrackets inset={4} size={8} opacity={0.25} hue={HUE} />

        {safePoster ? (
          <img src={safePoster} alt={title} style={s.poster} />
        ) : (
          <div style={s.monogram} data-testid="monogram" aria-hidden>
            {initial}
          </div>
        )}

        <div style={s.body}>
          <div style={s.titleRow}>
            <span style={s.title}>{title}</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-end' }}>
              <span style={s.localBadge} data-testid="local-badge">LOCAL</span>
              {isLocked && (
                <span style={s.lockedBadge} data-testid="locked-badge">LOCK</span>
              )}
            </div>
          </div>
          {series.totalEpisodes != null && (
            <span style={s.epCount}>{series.totalEpisodes}</span>
          )}
          {progressPct != null && (
            <div style={s.progressTrack} data-testid="progress-bar">
              <div style={s.progressFill(progressPct)} />
            </div>
          )}
        </div>
      </button>

      {onOverrideAction && (
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

      {menuOpen && onOverrideAction && (
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

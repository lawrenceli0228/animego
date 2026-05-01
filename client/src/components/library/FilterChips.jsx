// @ts-check
import { mono } from '../shared/hud-tokens';

/** @typedef {'recent'|'new'|'inProgress'|'done'|null} LibraryFilter */

const CHIPS = /** @type {{ id: Exclude<LibraryFilter, null>, label: string }[]} */ ([
  { id: 'recent',     label: '最近播放' },
  { id: 'new',        label: '新加入'   },
  { id: 'inProgress', label: '未看完'   },
  { id: 'done',       label: '已完结'   },
]);

const s = {
  row: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 12,
  },
  // §5.4 — design's filled-accent active chip. Inactive uses Apple system fill
  // grey (matches the design board tokens). Hover lift handled inline below.
  chip: (active) => ({
    fontFamily: "'DM Sans', sans-serif",
    height: 32,
    padding: '0 14px',
    background: active ? '#0a84ff' : 'rgba(120,120,128,0.12)',
    border: 'none',
    borderRadius: 9999,
    color: active ? '#fff' : 'rgba(235,235,245,0.60)',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 500,
    letterSpacing: 0,
    transition: 'background 150ms ease-out, color 150ms ease-out',
    display: 'inline-flex',
    alignItems: 'center',
  }),
  clear: {
    ...mono,
    marginLeft: 4,
    padding: '6px 10px',
    background: 'transparent',
    border: 'none',
    color: 'rgba(235,235,245,0.45)',
    cursor: 'pointer',
    fontSize: 11,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
  },
};

/**
 * FilterChips — §5.4 library browse filter row.
 *
 * Renders the 4 sort/filter chips: 最近播放 / 新加入 / 未看完 / 已完结.
 * Single-select; clicking the active chip clears the filter. Empty state
 * (no active filter) means the parent renders the default list order.
 *
 * @param {{
 *   active: LibraryFilter,
 *   onChange: (next: LibraryFilter) => void,
 * }} props
 */
export default function FilterChips({ active, onChange }) {
  return (
    <div style={s.row} data-testid="library-filters" role="toolbar" aria-label="库筛选">
      {CHIPS.map((c) => {
        const isActive = active === c.id;
        return (
          <button
            key={c.id}
            type="button"
            data-testid={`filter-chip-${c.id}`}
            data-active={isActive ? 'true' : 'false'}
            aria-pressed={isActive}
            style={s.chip(isActive)}
            onClick={() => onChange(isActive ? null : c.id)}
          >
            {c.label}
          </button>
        );
      })}
      {active && (
        <button
          type="button"
          data-testid="filter-chip-clear"
          style={s.clear}
          onClick={() => onChange(null)}
        >
          清除
        </button>
      )}
    </div>
  );
}

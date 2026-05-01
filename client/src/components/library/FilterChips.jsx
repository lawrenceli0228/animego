// @ts-check
import { mono, PLAYER_HUE } from '../shared/hud-tokens';

/** @typedef {'recent'|'new'|'inProgress'|'done'|null} LibraryFilter */

const HUE = PLAYER_HUE.stream;

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
    gap: 8,
  },
  chip: (active) => ({
    ...mono,
    padding: '6px 12px',
    background: active ? `oklch(62% 0.17 ${HUE} / 0.22)` : 'transparent',
    border: active
      ? `1px solid oklch(62% 0.17 ${HUE} / 0.65)`
      : '1px solid rgba(120,120,128,0.30)',
    borderRadius: 999,
    color: active
      ? `oklch(78% 0.14 ${HUE})`
      : 'rgba(235,235,245,0.70)',
    cursor: 'pointer',
    fontSize: 11,
    letterSpacing: '0.06em',
    transition: 'background 120ms ease-out, border-color 120ms ease-out',
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

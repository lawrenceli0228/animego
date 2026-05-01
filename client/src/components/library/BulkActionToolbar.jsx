// @ts-check
import { mono, PLAYER_HUE } from '../shared/hud-tokens';

const HUE = PLAYER_HUE.stream;

const s = {
  bar: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '10px 14px',
    background: `oklch(14% 0.04 ${HUE} / 0.85)`,
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.45)`,
    borderRadius: 6,
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
  },
  cancelBtn: {
    ...mono,
    padding: '6px 12px',
    background: 'transparent',
    border: '1px solid rgba(235,235,245,0.20)',
    borderRadius: 3,
    color: 'rgba(235,235,245,0.85)',
    cursor: 'pointer',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: '0.12em',
  },
  count: {
    ...mono,
    flex: 1,
    fontSize: 12,
    color: '#fff',
    letterSpacing: '0.05em',
    textAlign: 'center',
    fontVariantNumeric: 'tabular-nums',
  },
  countNum: {
    color: `oklch(78% 0.14 ${HUE})`,
    fontWeight: 600,
    marginRight: 4,
  },
  selectAllBtn: {
    ...mono,
    padding: '6px 12px',
    background: 'transparent',
    border: '1px solid rgba(235,235,245,0.20)',
    borderRadius: 3,
    color: 'rgba(235,235,245,0.85)',
    cursor: 'pointer',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: '0.12em',
  },
  primary: (disabled) => ({
    ...mono,
    padding: '6px 14px',
    background: disabled
      ? 'transparent'
      : `oklch(62% 0.17 ${HUE} / 0.22)`,
    border: disabled
      ? '1px solid rgba(235,235,245,0.18)'
      : `1px solid oklch(62% 0.17 ${HUE} / 0.65)`,
    borderRadius: 3,
    color: disabled
      ? 'rgba(235,235,245,0.35)'
      : `oklch(78% 0.14 ${HUE})`,
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: '0.12em',
  }),
};

/**
 * BulkActionToolbar — §5.6 iOS-style multi-select toolbar.
 *
 * Renders only when caller passes a non-zero `count`. Layout follows Apple HIG:
 *   [Cancel]   [N 项已选]   [Select All] [合并为系列]
 *
 * The merge button is disabled when fewer than 2 series are selected (the
 * design's minimum for a merge — pick a target and at least one source).
 *
 * @param {{
 *   count: number,
 *   onCancel: () => void,
 *   onSelectAll: () => void,
 *   onMerge: () => void,
 *   minMerge?: number,
 * }} props
 */
export default function BulkActionToolbar({
  count,
  onCancel,
  onSelectAll,
  onMerge,
  minMerge = 2,
}) {
  const canMerge = count >= minMerge;
  return (
    <div
      data-testid="bulk-toolbar"
      role="toolbar"
      aria-label="批量操作"
      style={s.bar}
    >
      <button
        type="button"
        data-testid="bulk-toolbar-cancel"
        style={s.cancelBtn}
        onClick={onCancel}
      >
        取消
      </button>
      <span style={s.count} data-testid="bulk-toolbar-count">
        <span style={s.countNum}>{count}</span>项已选
      </span>
      <button
        type="button"
        data-testid="bulk-toolbar-select-all"
        style={s.selectAllBtn}
        onClick={onSelectAll}
      >
        全选
      </button>
      <button
        type="button"
        data-testid="bulk-toolbar-merge"
        style={s.primary(!canMerge)}
        disabled={!canMerge}
        aria-disabled={!canMerge}
        onClick={canMerge ? onMerge : undefined}
      >
        合并为系列
      </button>
    </div>
  );
}

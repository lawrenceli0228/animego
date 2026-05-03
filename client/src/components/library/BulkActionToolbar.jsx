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
  danger: (disabled) => ({
    ...mono,
    padding: '6px 14px',
    background: disabled ? 'transparent' : 'oklch(60% 0.20 25 / 0.18)',
    border: disabled
      ? '1px solid rgba(235,235,245,0.18)'
      : '1px solid oklch(60% 0.20 25 / 0.55)',
    borderRadius: 3,
    color: disabled ? 'rgba(235,235,245,0.35)' : 'oklch(78% 0.18 25)',
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
 *   [Cancel]   [N 项已选]   [Select All] [Delete] [合并为系列]
 *
 * Delete: red Danger-Zone styling, sits between 全选 and 合并 so it's reachable
 *   in selection mode without leaving the toolbar. Disabled at count=0; the
 *   parent confirms via window.confirm before purging.
 * Merge: disabled below `minMerge` (default 2 — pick a target and a source).
 *
 * @param {{
 *   count: number,
 *   onCancel: () => void,
 *   onSelectAll: () => void,
 *   onMerge: () => void,
 *   onDelete?: () => void,
 *   minMerge?: number,
 * }} props
 */
export default function BulkActionToolbar({
  count,
  onCancel,
  onSelectAll,
  onMerge,
  onDelete,
  minMerge = 2,
}) {
  const canMerge = count >= minMerge;
  const canDelete = count > 0 && !!onDelete;
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
      {onDelete && (
        <button
          type="button"
          data-testid="bulk-toolbar-delete"
          style={s.danger(!canDelete)}
          disabled={!canDelete}
          aria-disabled={!canDelete}
          onClick={canDelete ? onDelete : undefined}
        >
          删除
        </button>
      )}
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

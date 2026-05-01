// @ts-check
import { useEffect, useRef } from 'react';
import { mono, PLAYER_HUE } from '../shared/hud-tokens';
import { CornerBrackets } from '../shared/hud';

/** @typedef {import('../../lib/library/types').OpsLog} OpsLog */

const HUE = PLAYER_HUE.stream;

const KIND_META = {
  merge:   { glyph: '⇉', label: '合并',   color: `oklch(72% 0.15 ${HUE})` },
  split:   { glyph: '⇇', label: '拆分',   color: 'oklch(75% 0.15 145)' },
  rematch: { glyph: '⟲', label: '重新匹配', color: 'oklch(78% 0.16 70)' },
  unfile:  { glyph: '✕', label: '取消归档', color: 'rgba(235,235,245,0.55)' },
  delete:  { glyph: '⌫', label: '删除',   color: 'oklch(70% 0.20 25)' },
};

const s = {
  scrim: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.55)',
    zIndex: 800,
  },
  drawer: {
    position: 'fixed',
    top: 24,
    right: 24,
    width: 380,
    maxWidth: 'calc(100vw - 48px)',
    maxHeight: 'calc(100vh - 48px)',
    display: 'flex',
    flexDirection: 'column',
    background: `oklch(12% 0.03 ${HUE} / 0.96)`,
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.55)`,
    borderRadius: 6,
    boxShadow: '0 8px 32px oklch(2% 0 0 / 0.6)',
    color: '#fff',
    overflow: 'hidden',
    zIndex: 900,
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
  },
  header: {
    padding: '14px 18px 10px',
    borderBottom: `1px solid oklch(46% 0.06 ${HUE} / 0.30)`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  kicker: {
    ...mono,
    fontSize: 10,
    color: `oklch(72% 0.15 ${HUE})`,
    textTransform: 'uppercase',
    letterSpacing: '0.18em',
  },
  closeBtn: {
    ...mono,
    background: 'transparent',
    border: 'none',
    color: 'rgba(235,235,245,0.65)',
    cursor: 'pointer',
    fontSize: 14,
    padding: 4,
    lineHeight: 1,
  },
  list: {
    flex: 1,
    overflowY: 'auto',
    padding: '8px 6px',
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  empty: {
    ...mono,
    padding: '32px 18px',
    textAlign: 'center',
    color: 'rgba(235,235,245,0.55)',
    fontSize: 11,
    letterSpacing: '0.05em',
  },
  row: {
    display: 'grid',
    gridTemplateColumns: '24px 1fr auto',
    gap: 10,
    alignItems: 'start',
    padding: '10px 12px',
    fontSize: 12,
  },
  rowUndone: {
    opacity: 0.45,
  },
  glyph: {
    ...mono,
    fontSize: 13,
    textAlign: 'center',
    lineHeight: '18px',
  },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    minWidth: 0,
  },
  kindLabel: {
    ...mono,
    fontSize: 10,
    color: `oklch(72% 0.15 ${HUE})`,
    textTransform: 'uppercase',
    letterSpacing: '0.12em',
  },
  summary: {
    fontSize: 12,
    color: 'rgba(235,235,245,0.85)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  summaryUndone: {
    textDecoration: 'line-through',
  },
  ts: {
    ...mono,
    fontSize: 10,
    color: 'rgba(235,235,245,0.40)',
    letterSpacing: '0.05em',
  },
  undoneTag: {
    ...mono,
    fontSize: 9,
    color: 'rgba(235,235,245,0.55)',
    border: '1px solid rgba(235,235,245,0.20)',
    borderRadius: 2,
    padding: '1px 5px',
    textTransform: 'uppercase',
    letterSpacing: '0.10em',
    alignSelf: 'flex-start',
  },
};

/**
 * Lightweight relative-time formatter — Chinese only (drawer is detail-page chrome,
 * which is locked to zh until the rest of LocalSeriesPage opts into i18n).
 *
 * @param {number} ts unix ms
 * @param {number} now unix ms
 */
export function formatTimeAgo(ts, now = Date.now()) {
  const diff = Math.floor((now - ts) / 1000);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  const days = Math.floor(diff / 86400);
  if (days < 30) return `${days} 天前`;
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Render a one-line summary text from an OpsLog row. Falls back to kind-only
 * when summary fields are missing so old rows still produce something readable.
 *
 * @param {OpsLog} entry
 */
function summaryLineFor(entry) {
  const sum = /** @type {Record<string, string|number|undefined>} */ (entry.summary ?? {});
  const target = typeof sum.targetTitle === 'string' ? sum.targetTitle : '';
  const source = typeof sum.sourceTitle === 'string' ? sum.sourceTitle : '';
  const name   = typeof sum.name === 'string' ? sum.name : '';
  switch (entry.kind) {
    case 'merge':
      if (source && target) return `合并 ${source} → ${target}`;
      if (target) return `合并到 ${target}`;
      return '合并';
    case 'split':
      if (name) return `拆分出新系列「${name}」`;
      return '拆分系列';
    case 'rematch':
      if (target) return `重新匹配为 ${target}`;
      return '重新匹配';
    case 'unfile':
      return '从系列移除';
    case 'delete':
      return '删除';
    default:
      return entry.kind;
  }
}

/**
 * OpsLogDrawer — §5.6 v3 操作日志抽屉。
 *
 * 详情页 Actions 菜单触发,展示该系列最近 24h(实际 listForSeries 默认 50 条)
 * 写库操作。撤销在 UndoToast 里完成,这里只读;已撤销条目以划线 + UNDONE 角标
 * 显示便于审计。
 *
 * 纯渲染组件,数据由父组件传入,便于测试 + 复用。
 *
 * @param {{
 *   open: boolean,
 *   entries: OpsLog[],
 *   onClose: () => void,
 *   now?: number,
 * }} props
 */
export default function OpsLogDrawer({ open, entries, onClose, now }) {
  const drawerRef = useRef(/** @type {HTMLDivElement|null} */ (null));

  useEffect(() => {
    if (!open) return undefined;
    function onKey(e) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div
        style={s.scrim}
        data-testid="opslog-scrim"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={drawerRef}
        role="dialog"
        aria-label="操作日志"
        data-testid="opslog-drawer"
        style={s.drawer}
      >
        <CornerBrackets inset={4} size={10} opacity={0.35} hue={HUE} />

        <div style={s.header}>
          <span style={s.kicker} data-testid="opslog-title">// OPS.LOG · 24H //</span>
          <button
            type="button"
            data-testid="opslog-close"
            style={s.closeBtn}
            onClick={onClose}
            aria-label="关闭"
          >
            ×
          </button>
        </div>

        <div style={s.list} data-testid="opslog-list">
          {entries.length === 0 ? (
            <div style={s.empty} data-testid="opslog-empty">
              该系列暂无近期操作
            </div>
          ) : (
            entries.map((entry) => {
              const meta = KIND_META[entry.kind] ?? { glyph: '·', label: entry.kind, color: 'rgba(235,235,245,0.55)' };
              const undone = !!entry.undone;
              return (
                <div
                  key={entry.id}
                  data-testid={`opslog-row-${entry.id}`}
                  data-kind={entry.kind}
                  data-undone={undone ? '1' : '0'}
                  style={{ ...s.row, ...(undone ? s.rowUndone : null) }}
                >
                  <span style={{ ...s.glyph, color: meta.color }} aria-hidden>
                    {meta.glyph}
                  </span>
                  <div style={s.body}>
                    <span style={s.kindLabel}>{meta.label}</span>
                    <span style={{ ...s.summary, ...(undone ? s.summaryUndone : null) }}>
                      {summaryLineFor(entry)}
                    </span>
                    <span style={s.ts}>{formatTimeAgo(entry.ts, now)}</span>
                  </div>
                  {undone && (
                    <span style={s.undoneTag} data-testid={`opslog-undone-${entry.id}`}>
                      UNDONE
                    </span>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}

// @ts-check
import { useEffect, useMemo, useRef } from 'react';
import { mono, PLAYER_HUE } from '../shared/hud-tokens';
import { CornerBrackets } from '../shared/hud';
import PrivacyHint from '../shared/PrivacyHint';

/** @typedef {import('../../lib/library/types').ImportEvent} ImportEvent */
/** @typedef {import('../../services/importPipeline').ImportSummary} ImportSummary */
/** @typedef {'idle'|'running'|'done'|'error'} ImportStatus */
/** @typedef {'pending'|'running'|'matched'|'ambiguous'|'failed'} RowState */

const HUE = PLAYER_HUE.stream;

const STATUS_COLORS = {
  matched:   { glyph: '✓', color: 'oklch(75% 0.18 145)' },
  running:   { glyph: '⟳', color: 'oklch(70% 0.18 240)' },
  pending:   { glyph: '·', color: 'rgba(235,235,245,0.40)' },
  ambiguous: { glyph: '⚠', color: 'oklch(78% 0.16 70)'  },
  failed:    { glyph: '✗', color: 'oklch(70% 0.20 25)'  },
};

const s = {
  drawer: {
    position: 'fixed',
    top: 24,
    right: 24,
    width: 420,
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
    padding: '24px 18px',
    textAlign: 'center',
    color: 'rgba(235,235,245,0.55)',
    fontSize: 11,
    letterSpacing: '0.05em',
  },
  row: {
    ...mono,
    display: 'grid',
    gridTemplateColumns: '20px 1fr auto',
    gap: 10,
    alignItems: 'center',
    padding: '8px 12px',
    fontSize: 11,
    color: 'rgba(235,235,245,0.85)',
    borderRadius: 3,
  },
  glyph: {
    fontSize: 12,
    textAlign: 'center',
    width: 16,
    fontWeight: 600,
  },
  rowKey: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    letterSpacing: '0.04em',
  },
  rowMeta: {
    ...mono,
    fontSize: 10,
    color: 'rgba(235,235,245,0.45)',
    letterSpacing: '0.06em',
  },
  footer: {
    padding: '10px 18px',
    borderTop: `1px solid oklch(46% 0.06 ${HUE} / 0.30)`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  counter: {
    ...mono,
    fontSize: 11,
    color: 'rgba(235,235,245,0.70)',
    letterSpacing: '0.10em',
    textTransform: 'uppercase',
  },
  errorMsg: {
    ...mono,
    padding: '8px 18px',
    background: 'oklch(20% 0.04 25 / 0.45)',
    color: 'oklch(78% 0.15 25)',
    fontSize: 10,
    letterSpacing: '0.05em',
    borderTop: '1px solid oklch(60% 0.20 25 / 0.40)',
  },
  cancelBtn: {
    ...mono,
    padding: '6px 14px',
    background: 'transparent',
    border: '1px solid oklch(60% 0.20 25 / 0.50)',
    borderRadius: 3,
    color: 'oklch(72% 0.18 25)',
    cursor: 'pointer',
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: '0.12em',
  },
  dismissBtn: {
    ...mono,
    padding: '6px 14px',
    background: `oklch(62% 0.17 ${HUE} / 0.20)`,
    border: `1px solid oklch(62% 0.17 ${HUE} / 0.55)`,
    borderRadius: 3,
    color: `oklch(72% 0.15 ${HUE})`,
    cursor: 'pointer',
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: '0.12em',
  },
  pulse: {
    animation: 'animego-import-pulse 1.4s ease-in-out infinite',
  },
};

const PULSE_KEYFRAMES = `
@keyframes animego-import-pulse {
  0%, 100% { opacity: 0.55; }
  50%      { opacity: 1; }
}
`;

/**
 * Aggregate the ImportEvent stream into per-cluster row state.
 * Order is preserved by clusterStart insertion; later events update in place.
 *
 * @param {ImportEvent[]} events
 * @returns {{ rows: { clusterKey: string, total: number, state: RowState, error?: string }[], total: number, finished: number }}
 */
export function aggregateEvents(events) {
  const map = new Map();
  for (const e of events) {
    if (!e.clusterKey && e.kind !== 'finish') continue;
    if (e.kind === 'clusterStart') {
      map.set(e.clusterKey, { clusterKey: e.clusterKey, total: e.total ?? 0, state: 'running' });
    } else if (e.kind === 'clusterDone') {
      const cur = map.get(e.clusterKey) ?? { clusterKey: e.clusterKey, total: 0, state: 'running' };
      const verdict = e.verdict;
      const next = verdict === 'matched' ? 'matched' : verdict === 'ambiguous' ? 'ambiguous' : 'failed';
      map.set(e.clusterKey, { ...cur, state: next });
    } else if (e.kind === 'failed' && e.clusterKey) {
      const cur = map.get(e.clusterKey) ?? { clusterKey: e.clusterKey, total: 0, state: 'failed' };
      map.set(e.clusterKey, { ...cur, state: 'failed', error: e.error });
    }
  }
  const rows = Array.from(map.values());
  const finished = rows.filter((r) => r.state !== 'running' && r.state !== 'pending').length;
  return { rows, total: rows.length, finished };
}

/**
 * ImportDrawer — non-blocking import progress drawer (design §5.3).
 *
 * Shows per-cluster verdict rows with status glyphs, a footer counter, and a
 * cancel/dismiss control depending on status. Hidden when status='idle' or no
 * events have been emitted yet.
 *
 * @param {{
 *   status: ImportStatus,
 *   progress: ImportEvent[],
 *   summary: ImportSummary | null,
 *   error?: string | null,
 *   onCancel?: () => void,
 *   onDismiss?: () => void,
 * }} props
 */
export default function ImportDrawer({
  status,
  progress,
  summary,
  error,
  onCancel,
  onDismiss,
}) {
  const styleTagInjected = useRef(false);
  useEffect(() => {
    if (styleTagInjected.current) return;
    if (typeof document === 'undefined') return;
    if (document.getElementById('animego-import-pulse-styles')) {
      styleTagInjected.current = true;
      return;
    }
    const tag = document.createElement('style');
    tag.id = 'animego-import-pulse-styles';
    tag.textContent = PULSE_KEYFRAMES;
    document.head.appendChild(tag);
    styleTagInjected.current = true;
  }, []);

  const { rows, total, finished } = useMemo(() => aggregateEvents(progress ?? []), [progress]);

  if (status === 'idle' && rows.length === 0) return null;

  const showCancel = status === 'running' && typeof onCancel === 'function';
  const showDismiss = (status === 'done' || status === 'error') && typeof onDismiss === 'function';
  const summaryDone = summary
    ? summary.matched + summary.ambiguous + summary.failed
    : null;
  const useSummary = (status === 'done' || status === 'error') && summary;
  const counterTotal = useSummary ? summary.clusters : (total || summary?.clusters || 0);
  const counterDone = useSummary ? summaryDone : finished;

  return (
    <div
      data-testid="import-drawer"
      role="status"
      aria-live="polite"
      aria-label="导入进度"
      style={s.drawer}
    >
      <CornerBrackets inset={4} size={10} opacity={0.35} hue={HUE} />

      <div style={s.header}>
        <span style={s.kicker} data-testid="import-drawer-title">// IMPORT.QUEUE //</span>
        {showDismiss && (
          <button
            type="button"
            data-testid="import-drawer-close"
            style={s.closeBtn}
            onClick={onDismiss}
            aria-label="关闭"
          >
            ×
          </button>
        )}
      </div>

      <div style={s.list} data-testid="import-drawer-list">
        {rows.length === 0 ? (
          <div style={s.empty} data-testid="import-drawer-empty">准备中…</div>
        ) : (
          rows.map((row) => {
            const meta = STATUS_COLORS[row.state] ?? STATUS_COLORS.pending;
            const isRunning = row.state === 'running';
            return (
              <div
                key={row.clusterKey}
                data-testid={`import-row-${row.clusterKey}`}
                data-state={row.state}
                style={s.row}
              >
                <span
                  aria-hidden
                  style={{
                    ...s.glyph,
                    color: meta.color,
                    ...(isRunning ? s.pulse : null),
                  }}
                >
                  {meta.glyph}
                </span>
                <span style={s.rowKey} title={row.clusterKey}>{row.clusterKey}</span>
                <span style={s.rowMeta}>{row.total} EP</span>
              </div>
            );
          })
        )}
      </div>

      {error && (
        <div style={s.errorMsg} data-testid="import-drawer-error">
          {error}
        </div>
      )}

      <div style={s.footer}>
        <span style={s.counter} data-testid="import-drawer-counter">
          完成 {counterDone} / {counterTotal}
        </span>
        {showCancel && (
          <button
            type="button"
            data-testid="import-drawer-cancel"
            style={s.cancelBtn}
            onClick={onCancel}
          >
            取消
          </button>
        )}
        {showDismiss && (
          <button
            type="button"
            data-testid="import-drawer-dismiss"
            style={s.dismissBtn}
            onClick={onDismiss}
          >
            完成
          </button>
        )}
      </div>

      <div style={{ padding: '4px 18px 12px' }}>
        <PrivacyHint compact />
      </div>
    </div>
  );
}

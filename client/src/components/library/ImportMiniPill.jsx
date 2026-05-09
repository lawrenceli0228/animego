// @ts-check
import { useMemo } from 'react';
import { mono } from '../shared/hud-tokens';
import { aggregateEvents } from './ImportDrawer';

/** @typedef {import('../../lib/library/types').ImportEvent} ImportEvent */

const SPIN_KEYFRAMES = `
@keyframes animego-mini-spin { to { transform: rotate(360deg); } }
`;

const s = {
  pill: {
    ...mono,
    position: 'fixed',
    right: 24,
    bottom: 24,
    zIndex: 880,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 14px',
    background: 'rgba(28,28,30,0.92)',
    border: '1px solid rgba(10,132,255,0.50)',
    borderRadius: 9999,
    color: '#fff',
    fontSize: 12,
    cursor: 'pointer',
    boxShadow: '0 8px 24px rgba(0,0,0,0.50), 0 0 0 1px rgba(10,132,255,0.18)',
    backdropFilter: 'saturate(180%) blur(12px)',
    WebkitBackdropFilter: 'saturate(180%) blur(12px)',
  },
  spinner: {
    width: 14,
    height: 14,
    borderRadius: '50%',
    border: '2px solid rgba(10,132,255,0.30)',
    borderTopColor: '#0a84ff',
    animation: 'animego-mini-spin 0.8s linear infinite',
    flexShrink: 0,
  },
  counter: {
    fontVariantNumeric: 'tabular-nums',
    color: '#fff',
  },
  total: { color: 'rgba(235,235,245,0.45)' },
  expand: {
    color: 'rgba(235,235,245,0.45)',
    fontSize: 11,
    marginLeft: 4,
  },
};

/**
 * ImportMiniPill — collapsed indicator shown while an import runs in the
 * background after the user dismisses the drawer.
 *
 * Click anywhere on the pill to reopen the full drawer. Renders nothing when
 * status is not 'running' — caller can mount unconditionally and let the
 * pill self-gate.
 *
 * @param {{
 *   status: 'idle'|'running'|'done'|'error',
 *   progress: ImportEvent[],
 *   summary: import('../../services/importPipeline').ImportSummary | null,
 *   onExpand: () => void,
 * }} props
 */
export default function ImportMiniPill({ status, progress, summary, onExpand }) {
  const { rows, total, finished } = useMemo(
    () => aggregateEvents(progress ?? []),
    [progress],
  );

  if (status !== 'running') return null;
  // No data yet → don't show a "0 / 0" pill while the pipeline boots.
  if (rows.length === 0 && !summary) return null;

  const counterTotal = total || summary?.clusters || 0;
  const counterDone = finished;

  return (
    <button
      type="button"
      data-testid="import-mini-pill"
      style={s.pill}
      onClick={onExpand}
      aria-label="展开导入进度抽屉"
    >
      <style>{SPIN_KEYFRAMES}</style>
      <span aria-hidden style={s.spinner} />
      <span>导入中</span>
      <span style={s.counter}>
        {counterDone} <span style={s.total}>/ {counterTotal}</span>
      </span>
      <span style={s.expand} aria-hidden>展开 ↗</span>
    </button>
  );
}

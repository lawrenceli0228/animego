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

// Status palette tied to design tokens — DESIGN.md §5.10:
//   matched   ⇒ system green   (#30d158)
//   running   ⇒ iOS blue       (#0a84ff, accent)
//   ambiguous ⇒ system warning (#ff9f0a)
//   failed    ⇒ system error   (#ff453a)
// `bg` is the icon-disc tint at ~12% opacity, pre-baked rather than computed
// inline so we don't need to detect hex/rgba color formats.
const STATUS_META = {
  matched:   { glyph: '✓', color: '#30d158', bg: 'rgba(48,209,88,0.14)',  label: '已识别' },
  running:   { glyph: '⟳', color: '#0a84ff', bg: 'rgba(10,132,255,0.14)', label: '解析中' },
  pending:   { glyph: '·', color: 'rgba(235,235,245,0.40)', bg: 'rgba(235,235,245,0.06)', label: '待解析' },
  ambiguous: { glyph: '⚠', color: '#ff9f0a', bg: 'rgba(255,159,10,0.14)', label: '待选' },
  failed:    { glyph: '✗', color: '#ff453a', bg: 'rgba(255,69,58,0.14)',  label: '失败' },
};

const GROUP_ORDER = /** @type {RowState[]} */ (['running', 'ambiguous', 'failed', 'matched', 'pending']);

const s = {
  scrim: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.55)',
    backdropFilter: 'blur(4px)',
    WebkitBackdropFilter: 'blur(4px)',
    zIndex: 880,
  },
  drawer: {
    position: 'fixed',
    top: 0,
    right: 0,
    bottom: 0,
    width: 460,
    maxWidth: '100vw',
    background: '#1c1c1e',
    borderLeft: '1px solid rgba(84,84,88,0.65)',
    boxShadow: '-16px 0 48px rgba(0,0,0,0.6)',
    color: '#fff',
    display: 'flex',
    flexDirection: 'column',
    zIndex: 900,
  },
  header: {
    position: 'relative',
    padding: '20px 24px 16px',
    borderBottom: '1px solid #38383a',
    flexShrink: 0,
  },
  kickerRow: {
    ...mono,
    fontSize: 10,
    color: 'rgba(235,235,245,0.30)',
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    marginBottom: 8,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  privacyMini: {
    ...mono,
    marginLeft: 'auto',
    color: '#30d158',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 9,
  },
  privacyMiniDot: {
    width: 5,
    height: 5,
    borderRadius: '50%',
    background: '#30d158',
    boxShadow: '0 0 6px #30d158',
    animation: 'animego-import-pulse 2s ease-in-out infinite',
  },
  titleRow: {
    fontFamily: "'Sora', sans-serif",
    fontWeight: 700,
    fontSize: 22,
    letterSpacing: '-0.02em',
    color: '#fff',
    margin: '0 0 6px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  closeBtn: {
    ...mono,
    width: 32,
    height: 32,
    background: 'transparent',
    border: 'none',
    color: 'rgba(235,235,245,0.30)',
    borderRadius: 8,
    cursor: 'pointer',
    fontSize: 18,
    lineHeight: 1,
  },
  subtitle: {
    fontSize: 13,
    color: 'rgba(235,235,245,0.60)',
    marginBottom: 16,
  },
  // Meter — 12 / 47 progress with bar + 4-stat row.
  meter: {
    background: '#2c2c2e',
    border: '1px solid #38383a',
    borderRadius: 12,
    padding: '14px 16px',
  },
  meterRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  meterLabel: {
    ...mono,
    fontSize: 10,
    color: 'rgba(235,235,245,0.30)',
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
  },
  meterCounter: {
    ...mono,
    fontVariantNumeric: 'tabular-nums',
    fontSize: 14,
    color: '#fff',
  },
  meterCounterTotal: { color: 'rgba(235,235,245,0.30)' },
  meterBar: {
    position: 'relative',
    height: 4,
    background: 'oklch(62% 0.17 210 / 0.25)',
    borderRadius: 9999,
    overflow: 'hidden',
    marginBottom: 10,
  },
  meterFill: (pct) => ({
    height: '100%',
    width: `${Math.max(0, Math.min(1, pct)) * 100}%`,
    background: '#0a84ff',
    borderRadius: 9999,
    transition: 'width 250ms cubic-bezier(0.4,0,0.2,1)',
  }),
  meterStats: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: 6,
    fontSize: 11,
    fontFamily: "'JetBrains Mono', monospace",
  },
  stat: (color) => ({
    color,
    display: 'flex',
    alignItems: 'center',
    gap: 4,
  }),
  statNum: { color: '#fff', fontWeight: 500 },

  // Body — scrollable list, grouped by state.
  body: {
    flex: 1,
    overflowY: 'auto',
    padding: '8px 16px',
    display: 'flex',
    flexDirection: 'column',
  },
  groupLabel: {
    ...mono,
    fontSize: 10,
    color: 'rgba(235,235,245,0.30)',
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    padding: '16px 8px 8px',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  groupCount: {
    color: 'rgba(235,235,245,0.60)',
    fontVariantNumeric: 'tabular-nums',
  },
  // File row — mono name + meta + glyph.
  row: {
    padding: '10px 8px',
    borderRadius: 8,
    marginBottom: 4,
    display: 'grid',
    gridTemplateColumns: '22px 1fr',
    gap: 10,
    alignItems: 'center',
  },
  rowIcon: (color, bg, animate) => ({
    width: 22,
    height: 22,
    borderRadius: '50%',
    background: bg,
    color,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 12,
    flexShrink: 0,
    ...(animate ? { animation: 'animego-import-pulse 1.2s ease-in-out infinite' } : null),
  }),
  rowInfo: { minWidth: 0 },
  rowName: {
    ...mono,
    fontSize: 12,
    color: '#fff',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    marginBottom: 2,
    letterSpacing: '0.04em',
  },
  rowMeta: {
    ...mono,
    fontSize: 11,
    color: 'rgba(235,235,245,0.30)',
    letterSpacing: '0.05em',
  },
  empty: {
    ...mono,
    padding: '24px 18px',
    textAlign: 'center',
    color: 'rgba(235,235,245,0.55)',
    fontSize: 11,
    letterSpacing: '0.05em',
  },

  // Error strip — sits above the footer.
  errorMsg: {
    ...mono,
    padding: '10px 24px',
    background: 'rgba(255,69,58,0.12)',
    color: '#ff453a',
    fontSize: 11,
    letterSpacing: '0.05em',
    borderTop: '1px solid rgba(255,69,58,0.30)',
  },

  // Footer — counter + actions.
  footer: {
    padding: '14px 24px',
    borderTop: '1px solid #38383a',
    background: 'rgba(28,28,30,0.95)',
    backdropFilter: 'blur(8px)',
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  footerSummary: {
    fontSize: 12,
    color: 'rgba(235,235,245,0.60)',
    display: 'flex',
    gap: 10,
    alignItems: 'center',
  },
  counter: {
    ...mono,
    fontVariantNumeric: 'tabular-nums',
    color: '#fff',
  },
  warnCount: { color: '#ff9f0a' },
  footerActions: { display: 'flex', gap: 8 },
  btnPrimary: {
    flex: 1,
    height: 38,
    background: '#0a84ff',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  },
  btnPrimaryDisabled: {
    flex: 1,
    height: 38,
    background: 'rgba(120,120,128,0.12)',
    color: 'rgba(235,235,245,0.30)',
    border: 'none',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'not-allowed',
  },
  btnGhost: {
    height: 38,
    padding: '0 14px',
    background: 'transparent',
    color: 'rgba(235,235,245,0.60)',
    border: '1px solid rgba(84,84,88,0.65)',
    borderRadius: 8,
    fontSize: 13,
    cursor: 'pointer',
  },
  btnDanger: {
    height: 38,
    padding: '0 14px',
    background: 'transparent',
    color: '#ff453a',
    border: '1px solid rgba(255,69,58,0.40)',
    borderRadius: 8,
    fontSize: 13,
    cursor: 'pointer',
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
 * Group aggregated rows by state, in fixed display order.
 *
 * @param {{ clusterKey: string, total: number, state: RowState, error?: string }[]} rows
 */
function groupRows(rows) {
  /** @type {Record<RowState, typeof rows>} */
  const buckets = { running: [], ambiguous: [], failed: [], matched: [], pending: [] };
  for (const r of rows) buckets[r.state].push(r);
  return GROUP_ORDER
    .map((state) => ({ state, rows: buckets[state] }))
    .filter((g) => g.rows.length > 0);
}

/**
 * ImportDrawer — right-anchored drawer rendering live import progress (§5.3).
 *
 * Replaces the floating mini-panel with the design-spec 460px right drawer:
 * scrim+blur backdrop, header with kicker / title / source / progress meter,
 * grouped status sections in the body, and a footer with cancel/dismiss
 * actions plus inline privacy hint.
 *
 * Hidden when status='idle' AND no events have been emitted yet — matches the
 * old contract so callers don't need to gate visibility themselves.
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
  const groups = useMemo(() => groupRows(rows), [rows]);

  if (status === 'idle' && rows.length === 0) return null;

  const showCancel = status === 'running' && typeof onCancel === 'function';
  const showDismiss = (status === 'done' || status === 'error') && typeof onDismiss === 'function';
  // While running, "在后台运行" lets the user collapse the drawer without
  // killing the import (LibraryPage shows a mini pill they can click to
  // re-open). Maps to the same onDismiss callback as the done-state "完成".
  const showBackground = status === 'running' && typeof onDismiss === 'function';

  // Counts derived from rows or final summary, whichever is more authoritative
  // for the current phase. While running, rows are the live source; when done,
  // summary captures the final partition (matched/ambiguous/failed).
  const useSummary = (status === 'done' || status === 'error') && summary;
  const stats = useSummary
    ? {
        matched: summary.matched,
        running: 0,
        ambiguous: summary.ambiguous,
        failed: summary.failed,
      }
    : rows.reduce(
        (acc, r) => ({ ...acc, [r.state]: (acc[r.state] ?? 0) + 1 }),
        { matched: 0, running: 0, ambiguous: 0, failed: 0, pending: 0 },
      );

  const counterTotal = useSummary
    ? summary.clusters
    : (total || summary?.clusters || 0);
  const counterDone = useSummary
    ? summary.matched + summary.ambiguous + summary.failed
    : finished;
  const meterPct = counterTotal > 0 ? counterDone / counterTotal : 0;

  return (
    <>
      <div
        data-testid="import-drawer-scrim"
        style={s.scrim}
        onClick={showDismiss ? onDismiss : undefined}
        aria-hidden
      />
      <aside
        data-testid="import-drawer"
        role="status"
        aria-live="polite"
        aria-label="导入进度"
        style={s.drawer}
      >
        <CornerBrackets inset={6} size={12} opacity={0.30} hue={HUE} />

        {/* HEADER */}
        <div style={s.header}>
          <div style={s.kickerRow}>
            <span data-testid="import-drawer-title">// IMPORT.QUEUE //</span>
            <span style={s.privacyMini}>
              <span aria-hidden style={s.privacyMiniDot} />
              所有解析在本地
            </span>
          </div>
          <h2 style={s.titleRow}>
            <span>导入本地文件</span>
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
          </h2>
          {counterTotal > 0 && (
            <div style={s.subtitle}>
              共 <strong style={{ color: '#fff' }}>{counterTotal}</strong> 个集群 · 进度 {Math.round(meterPct * 100)}%
            </div>
          )}

          <div style={s.meter}>
            <div style={s.meterRow}>
              <span style={s.meterLabel}>// 解析进度</span>
              <span style={s.meterCounter}>
                {counterDone} <span style={s.meterCounterTotal}>/ {counterTotal || '—'}</span>
              </span>
            </div>
            <div style={s.meterBar}>
              <div style={s.meterFill(meterPct)} />
            </div>
            <div style={s.meterStats}>
              <span style={s.stat(STATUS_META.matched.color)}>
                <span aria-hidden>{STATUS_META.matched.glyph}</span>
                <span style={s.statNum}>{stats.matched}</span> 成功
              </span>
              <span style={s.stat(STATUS_META.running.color)}>
                <span aria-hidden>{STATUS_META.running.glyph}</span>
                <span style={s.statNum}>{stats.running}</span> 解析中
              </span>
              <span style={s.stat(STATUS_META.ambiguous.color)}>
                <span aria-hidden>{STATUS_META.ambiguous.glyph}</span>
                <span style={s.statNum}>{stats.ambiguous}</span> 待选
              </span>
              <span style={s.stat(STATUS_META.failed.color)}>
                <span aria-hidden>{STATUS_META.failed.glyph}</span>
                <span style={s.statNum}>{stats.failed}</span> 失败
              </span>
            </div>
          </div>
        </div>

        {/* BODY — grouped rows */}
        <div style={s.body} data-testid="import-drawer-list">
          {rows.length === 0 ? (
            <div style={s.empty} data-testid="import-drawer-empty">准备中…</div>
          ) : (
            groups.map(({ state, rows: groupRowsList }) => {
              const meta = STATUS_META[state];
              return (
                <div key={state} data-testid={`import-group-${state}`}>
                  <div style={s.groupLabel}>
                    <span>// {meta.label}</span>
                    <span style={s.groupCount}>{groupRowsList.length}</span>
                  </div>
                  {groupRowsList.map((row) => {
                    const isRunning = row.state === 'running';
                    return (
                      <div
                        key={row.clusterKey}
                        data-testid={`import-row-${row.clusterKey}`}
                        data-state={row.state}
                        style={s.row}
                      >
                        <div
                          aria-hidden
                          style={s.rowIcon(meta.color, meta.bg, isRunning)}
                        >
                          {meta.glyph}
                        </div>
                        <div style={s.rowInfo}>
                          <div style={s.rowName} title={row.clusterKey}>
                            {row.clusterKey}
                          </div>
                          <div style={s.rowMeta}>
                            {row.total} EP{row.error ? ` · ${row.error}` : ''}
                          </div>
                        </div>
                      </div>
                    );
                  })}
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

        {/* FOOTER */}
        <div style={s.footer}>
          <div style={s.footerSummary}>
            <span data-testid="import-drawer-counter" style={s.counter}>
              完成 {counterDone} / {counterTotal}
            </span>
            {stats.ambiguous > 0 && (
              <>
                <span style={{ color: 'rgba(235,235,245,0.18)' }}>·</span>
                <span style={s.warnCount}>{stats.ambiguous} 项待选</span>
              </>
            )}
          </div>
          <div style={s.footerActions}>
            {showCancel ? (
              <button
                type="button"
                data-testid="import-drawer-cancel"
                style={s.btnDanger}
                onClick={onCancel}
              >
                取消导入
              </button>
            ) : null}
            {showBackground ? (
              <button
                type="button"
                data-testid="import-drawer-background"
                style={s.btnPrimary}
                onClick={onDismiss}
              >
                在后台运行
              </button>
            ) : null}
            {showDismiss ? (
              <button
                type="button"
                data-testid="import-drawer-dismiss"
                style={s.btnPrimary}
                onClick={onDismiss}
              >
                完成
              </button>
            ) : null}
          </div>
          <div style={{ paddingTop: 4 }}>
            <PrivacyHint compact />
          </div>
        </div>
      </aside>
    </>
  );
}

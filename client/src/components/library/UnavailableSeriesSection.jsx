// @ts-check
import { useMemo, useState } from 'react';
import { mono, PLAYER_HUE } from '../shared/hud-tokens';

/** @typedef {import('../../lib/library/types').Series} Series */
/** @typedef {import('../../lib/library/types').HandleRecord} HandleRecord */
/** @typedef {'ok'|'partial'|'offline'|'unknown'} SeriesAvailability */

const HUE = PLAYER_HUE.local;

const s = {
  wrap: {
    border: '1px solid oklch(60% 0.20 25 / 0.30)',
    borderRadius: 4,
    background: 'oklch(14% 0.04 25 / 0.18)',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '12px 16px',
    cursor: 'pointer',
    background: 'oklch(16% 0.05 25 / 0.36)',
    borderBottom: '1px solid oklch(60% 0.20 25 / 0.25)',
    width: '100%',
    border: 'none',
    textAlign: 'left',
  },
  headerCollapsed: { borderBottom: 'none' },
  kicker: {
    ...mono,
    fontSize: 11,
    color: 'oklch(78% 0.18 25)',
    textTransform: 'uppercase',
    letterSpacing: '0.16em',
  },
  count: {
    ...mono,
    fontSize: 10,
    color: 'rgba(235,235,245,0.55)',
    letterSpacing: '0.10em',
  },
  spacer: { flex: 1 },
  refreshBtn: (busy) => ({
    ...mono,
    padding: '6px 12px',
    background: busy ? `oklch(46% 0.06 ${HUE} / 0.20)` : 'transparent',
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.55)`,
    borderRadius: 3,
    color: busy ? 'rgba(235,235,245,0.45)' : 'rgba(235,235,245,0.85)',
    cursor: busy ? 'wait' : 'pointer',
    fontSize: 9,
    textTransform: 'uppercase',
    letterSpacing: '0.12em',
    flexShrink: 0,
    opacity: busy ? 0.7 : 1,
  }),
  // Reauthorize is the actual recovery action when permissions lapsed after a
  // browser restart — refresh only re-probes, it can't re-grant. Styled with
  // accent fill so it reads as the primary CTA when the section appears.
  reauthBtn: (busy) => ({
    ...mono,
    padding: '6px 12px',
    background: busy
      ? `oklch(56% 0.14 ${HUE} / 0.30)`
      : `oklch(56% 0.14 ${HUE} / 0.18)`,
    border: `1px solid oklch(70% 0.16 ${HUE} / 0.65)`,
    borderRadius: 3,
    color: busy ? 'rgba(235,235,245,0.55)' : `oklch(82% 0.14 ${HUE})`,
    cursor: busy ? 'wait' : 'pointer',
    fontSize: 9,
    textTransform: 'uppercase',
    letterSpacing: '0.12em',
    flexShrink: 0,
    opacity: busy ? 0.7 : 1,
  }),
  caret: {
    ...mono,
    fontSize: 11,
    color: 'rgba(235,235,245,0.55)',
    transition: 'transform 150ms ease',
    flexShrink: 0,
    display: 'inline-block',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
  },
  row: {
    display: 'grid',
    gridTemplateColumns: '40px 1fr auto auto',
    gap: 12,
    alignItems: 'center',
    padding: '10px 16px',
    borderTop: '1px solid oklch(46% 0.06 0 / 0.10)',
  },
  poster: {
    width: 40,
    height: 60,
    borderRadius: 2,
    objectFit: 'cover',
    background: `oklch(18% 0.06 ${HUE} / 0.80)`,
    display: 'block',
  },
  monogram: {
    width: 40,
    height: 60,
    borderRadius: 2,
    background: `oklch(18% 0.06 ${HUE} / 0.80)`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: "'Sora', sans-serif",
    fontSize: 16,
    fontWeight: 700,
    color: `oklch(72% 0.15 ${HUE})`,
  },
  titleBlock: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  title: {
    fontFamily: "'Sora', sans-serif",
    fontWeight: 600,
    fontSize: 13,
    color: '#fff',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  reason: {
    ...mono,
    fontSize: 10,
    color: 'rgba(235,235,245,0.55)',
    letterSpacing: '0.05em',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  pill: {
    ...mono,
    fontSize: 9,
    padding: '2px 8px',
    borderRadius: 999,
    textTransform: 'uppercase',
    letterSpacing: '0.10em',
    fontWeight: 600,
    flexShrink: 0,
  },
  pillOffline: {
    background: 'oklch(60% 0.20 25 / 0.18)',
    border: '1px solid oklch(60% 0.20 25 / 0.45)',
    color: 'oklch(78% 0.18 25)',
  },
  pillPartial: {
    background: 'oklch(72% 0.16 70 / 0.18)',
    border: '1px solid oklch(72% 0.16 70 / 0.45)',
    color: 'oklch(82% 0.16 70)',
  },
  actionBtn: (variant) => {
    const base = {
      ...mono,
      padding: '5px 10px',
      background: 'transparent',
      borderRadius: 3,
      fontSize: 9,
      textTransform: 'uppercase',
      letterSpacing: '0.10em',
      flexShrink: 0,
      cursor: 'pointer',
    };
    if (variant === 'partial') {
      return {
        ...base,
        border: `1px solid oklch(46% 0.06 ${HUE} / 0.55)`,
        color: `oklch(72% 0.15 ${HUE})`,
      };
    }
    if (variant === 'danger') {
      return {
        ...base,
        border: '1px solid oklch(60% 0.20 25 / 0.50)',
        color: 'oklch(78% 0.18 25)',
      };
    }
    return {
      ...base,
      border: '1px solid rgba(84,84,88,0.40)',
      color: 'rgba(235,235,245,0.45)',
      cursor: 'not-allowed',
    };
  },
};

/**
 * UnavailableSeriesSection — collapsible section grouping series whose backing
 * files are offline (whole drive unplugged) or partial (some files reachable).
 * Replaces the in-grid `cardDimmed` treatment so the main grid only shows
 * accessible content. Mirrors the visual pattern of `UnclassifiedSection`.
 *
 * Section header carries two recovery actions:
 *   - "重新授权" (when `onReauthorize` is provided) prompts the browser
 *     permission dialog for every offline/denied library — this is the actual
 *     fix when permissions lapsed after a browser restart, since `probeRoot`
 *     classifies `prompt`-state handles as denied and renders OFFLINE rows.
 *   - "刷新可用性" re-probes persisted handles read-only. Useful when a drive
 *     was just plugged back in and permissions are still granted.
 *
 * Per-row affordances:
 *   - offline → "删除" purges the series record (metadata / progress / overrides)
 *     from IDB. Files on disk are untouched, so a re-import of the same folder
 *     restores everything. Reconnecting the drive is the section-level action.
 *   - partial → "打开" jumps to the player; user can play whatever episodes
 *     remain reachable.
 *
 * @param {{
 *   series: Series[],
 *   availabilityBySeries: Map<string, SeriesAvailability>,
 *   roots?: HandleRecord[],
 *   onRefresh: () => void | Promise<void>,
 *   onReauthorize?: () => void | Promise<void>,
 *   onPickSeries: (id: string) => void,
 *   onDelete?: (seriesId: string) => void,
 *   refreshing?: boolean,
 *   reauthorizing?: boolean,
 *   defaultOpen?: boolean,
 * }} props
 */
export default function UnavailableSeriesSection({
  series,
  availabilityBySeries,
  onRefresh,
  onReauthorize,
  onPickSeries,
  onDelete,
  refreshing = false,
  reauthorizing = false,
  defaultOpen = false,
}) {
  const [open, setOpen] = useState(defaultOpen);

  const sorted = useMemo(() => {
    return [...series].sort((a, b) => {
      // partial first (still actionable), offline second
      const av = (sr) => availabilityBySeries.get(sr.id) === 'partial' ? 0 : 1;
      const ao = av(a);
      const bo = av(b);
      if (ao !== bo) return ao - bo;
      const at = a.titleZh || a.titleEn || a.titleJa || a.id;
      const bt = b.titleZh || b.titleEn || b.titleJa || b.id;
      return at.localeCompare(bt);
    });
  }, [series, availabilityBySeries]);

  if (series.length === 0) return null;

  function handleHeaderClick(e) {
    if (e.target.closest('[data-testid="unavailable-refresh"]')) return;
    if (e.target.closest('[data-testid="unavailable-reauthorize"]')) return;
    setOpen((v) => !v);
  }

  function handleHeaderKey(e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setOpen((v) => !v);
    }
  }

  return (
    <section data-testid="unavailable-section" style={s.wrap}>
      <div
        role="button"
        tabIndex={0}
        data-testid="unavailable-toggle"
        style={{ ...s.header, ...(open ? null : s.headerCollapsed) }}
        onClick={handleHeaderClick}
        onKeyDown={handleHeaderKey}
        aria-expanded={open}
      >
        <span style={s.kicker}>// UNAVAILABLE //</span>
        <span style={s.count} data-testid="unavailable-count">
          {series.length} 项暂时不可访问
        </span>
        <span style={s.spacer} />
        {onReauthorize ? (
          <button
            type="button"
            data-testid="unavailable-reauthorize"
            style={s.reauthBtn(reauthorizing)}
            onClick={(e) => {
              e.stopPropagation();
              if (!reauthorizing) onReauthorize();
            }}
            disabled={reauthorizing}
            title="对每个离线文件夹弹出浏览器原生授权框,逐个重新授权"
          >
            {reauthorizing ? '授权中…' : '重新授权'}
          </button>
        ) : null}
        <button
          type="button"
          data-testid="unavailable-refresh"
          style={s.refreshBtn(refreshing)}
          onClick={(e) => {
            e.stopPropagation();
            if (!refreshing) onRefresh();
          }}
          disabled={refreshing}
          title="重新探测硬盘连接状态(不会弹授权框)"
        >
          {refreshing ? '检测中…' : '刷新可用性'}
        </button>
        <span
          style={{ ...s.caret, transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
          aria-hidden
        >
          ›
        </span>
      </div>

      {open && (
        <div style={s.list} data-testid="unavailable-list">
          {sorted.map((sr) => {
            const av = availabilityBySeries.get(sr.id);
            const isPartial = av === 'partial';
            const title = sr.titleZh || sr.titleEn || sr.titleJa || sr.id;
            const initial = (title.charAt(0) || '?').toUpperCase();
            const safePoster = typeof sr.posterUrl === 'string' && /^https:\/\//i.test(sr.posterUrl)
              ? sr.posterUrl : null;
            const reason = isPartial ? '部分集缺失' : '硬盘未连接';
            return (
              <div
                key={sr.id}
                data-testid={`unavailable-row-${sr.id}`}
                data-availability={av}
                style={s.row}
              >
                {safePoster ? (
                  <img src={safePoster} alt="" style={s.poster} />
                ) : (
                  <div style={s.monogram} aria-hidden>{initial}</div>
                )}
                <div style={s.titleBlock}>
                  <span style={s.title} title={title}>{title}</span>
                  <span style={s.reason}>{reason}</span>
                </div>
                <span style={{ ...s.pill, ...(isPartial ? s.pillPartial : s.pillOffline) }}>
                  {isPartial ? '⚠ PARTIAL' : '⊘ OFFLINE'}
                </span>
                {isPartial ? (
                  <button
                    type="button"
                    data-testid={`unavailable-open-${sr.id}`}
                    style={s.actionBtn('partial')}
                    onClick={() => onPickSeries(sr.id)}
                  >
                    打开
                  </button>
                ) : (
                  <button
                    type="button"
                    data-testid={`unavailable-delete-${sr.id}`}
                    style={s.actionBtn(onDelete ? 'danger' : 'offline')}
                    onClick={() => onDelete?.(sr.id)}
                    disabled={!onDelete}
                    title="从库里删除（不会动磁盘文件，重连后可重新导入）"
                  >
                    删除
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// @ts-check
import { useEffect, useMemo, useState } from 'react';
import { mono, PLAYER_HUE } from '../shared/hud-tokens';
import { CornerBrackets } from '../shared/hud';

/** @typedef {import('../../lib/library/types').Series} Series */

const HUE = PLAYER_HUE.stream;

const s = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'oklch(2% 0 0 / 0.65)',
    backdropFilter: 'blur(4px)',
    WebkitBackdropFilter: 'blur(4px)',
    zIndex: 1000,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  dialog: {
    position: 'relative',
    width: 'min(520px, 100%)',
    maxHeight: '80vh',
    display: 'flex',
    flexDirection: 'column',
    background: `oklch(12% 0.03 ${HUE} / 0.96)`,
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.55)`,
    borderRadius: 6,
    boxShadow: '0 8px 32px oklch(2% 0 0 / 0.6)',
    color: '#fff',
    overflow: 'hidden',
  },
  header: {
    padding: '16px 20px 12px',
    borderBottom: `1px solid oklch(46% 0.06 ${HUE} / 0.30)`,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  kicker: {
    ...mono,
    fontSize: 10,
    color: `oklch(72% 0.15 ${HUE})`,
    textTransform: 'uppercase',
    letterSpacing: '0.18em',
  },
  title: {
    fontFamily: "'Sora', sans-serif",
    fontWeight: 600,
    fontSize: 16,
    color: '#fff',
    lineHeight: 1.3,
  },
  searchWrap: {
    padding: '12px 20px',
    borderBottom: `1px solid oklch(46% 0.06 ${HUE} / 0.20)`,
  },
  search: {
    ...mono,
    width: '100%',
    padding: '8px 12px',
    background: `oklch(8% 0.02 ${HUE} / 0.7)`,
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.40)`,
    borderRadius: 3,
    color: '#fff',
    fontSize: 12,
    outline: 'none',
  },
  list: {
    flex: 1,
    overflowY: 'auto',
    padding: '8px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  target: {
    ...mono,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 12px',
    background: `oklch(14% 0.04 ${HUE} / 0.55)`,
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.30)`,
    borderRadius: 3,
    color: '#fff',
    fontSize: 12,
    cursor: 'pointer',
    textAlign: 'left',
    width: '100%',
  },
  targetMeta: {
    ...mono,
    fontSize: 10,
    color: `rgba(235,235,245,0.45)`,
    letterSpacing: '0.05em',
  },
  empty: {
    ...mono,
    padding: '32px 20px',
    textAlign: 'center',
    color: `rgba(235,235,245,0.55)`,
    fontSize: 12,
    letterSpacing: '0.05em',
  },
  footer: {
    padding: '12px 20px',
    borderTop: `1px solid oklch(46% 0.06 ${HUE} / 0.30)`,
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 8,
  },
  cancel: {
    ...mono,
    padding: '8px 16px',
    background: 'transparent',
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.50)`,
    borderRadius: 3,
    color: 'rgba(235,235,245,0.85)',
    cursor: 'pointer',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: '0.12em',
  },
};

function pickTitle(series) {
  return series?.titleEn || series?.titleZh || series?.titleJa || series?.id || '';
}

/**
 * MergeDialog — pick a target Series to merge the source Series into.
 *
 * The dialog renders a backdrop + modal. Clicking the backdrop, hitting Escape,
 * or pressing Cancel triggers `onClose`. Clicking a target row triggers
 * `onConfirm(targetSeriesId)`. Source series is filtered out of the list.
 *
 * @param {{
 *   open: boolean,
 *   sourceSeries: Series,
 *   allSeries: Series[],
 *   onClose: () => void,
 *   onConfirm: (targetSeriesId: string) => void,
 * }} props
 */
export default function MergeDialog({
  open,
  sourceSeries,
  allSeries,
  onClose,
  onConfirm,
}) {
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!open) return undefined;
    function onKey(e) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Reset search when dialog reopens so a stale query doesn't hide candidates.
  useEffect(() => {
    if (open) setQuery('');
  }, [open]);

  const candidates = useMemo(() => {
    if (!sourceSeries || !Array.isArray(allSeries)) return [];
    const q = query.trim().toLowerCase();
    return allSeries.filter((sr) => {
      if (sr.id === sourceSeries.id) return false;
      if (!q) return true;
      const t = pickTitle(sr).toLowerCase();
      return t.includes(q);
    });
  }, [allSeries, sourceSeries, query]);

  if (!open) return null;

  const sourceTitle = pickTitle(sourceSeries);

  return (
    <div
      data-testid="merge-dialog-backdrop"
      style={s.backdrop}
      onClick={onClose}
    >
      <div
        data-testid="merge-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="merge-source-title"
        style={s.dialog}
        onClick={(e) => e.stopPropagation()}
      >
        <CornerBrackets inset={4} size={10} opacity={0.35} hue={HUE} />

        <div style={s.header}>
          <span style={s.kicker}>合并到…</span>
          <span
            id="merge-source-title"
            data-testid="merge-source-title"
            style={s.title}
          >
            {sourceTitle}
          </span>
        </div>

        <div style={s.searchWrap}>
          <input
            data-testid="merge-search"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索目标系列…"
            style={s.search}
            aria-label="搜索目标系列"
          />
        </div>

        <div style={s.list}>
          {candidates.length === 0 ? (
            <div data-testid="merge-empty" style={s.empty}>
              {allSeries.length <= 1
                ? '暂无其它系列可作为合并目标'
                : '没有匹配的系列'}
            </div>
          ) : (
            candidates.map((sr) => (
              <button
                key={sr.id}
                type="button"
                data-testid={`merge-target-${sr.id}`}
                style={s.target}
                onClick={() => onConfirm(sr.id)}
              >
                <span>{pickTitle(sr)}</span>
                {sr.totalEpisodes != null && (
                  <span style={s.targetMeta}>{sr.totalEpisodes} EP</span>
                )}
              </button>
            ))
          )}
        </div>

        <div style={s.footer}>
          <button
            data-testid="merge-cancel"
            type="button"
            style={s.cancel}
            onClick={onClose}
          >
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

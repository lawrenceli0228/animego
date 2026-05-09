// @ts-check
import { useEffect } from 'react';
import { mono, PLAYER_HUE } from '../shared/hud-tokens';
import { CornerBrackets } from '../shared/hud';
import ManualSearch from '../player/ManualSearch';

/** @typedef {import('../../lib/library/types').Series} Series */
/**
 * @typedef {{
 *   animeId: number,
 *   titleZh?: string,
 *   titleEn?: string,
 *   posterUrl?: string,
 *   type: 'tv'|'movie'|'ova'|'web',
 * }} RematchPayload
 */

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
    width: 'min(640px, 100%)',
    maxHeight: '85vh',
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
  body: {
    flex: 1,
    overflowY: 'auto',
    padding: 0,
  },
  footer: {
    padding: '12px 20px',
    borderTop: `1px solid oklch(46% 0.06 ${HUE} / 0.30)`,
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 8,
  },
  cancelBtn: {
    ...mono,
    padding: '8px 16px',
    background: 'transparent',
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.55)`,
    borderRadius: 3,
    color: 'rgba(235,235,245,0.85)',
    cursor: 'pointer',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: '0.12em',
  },
};

function pickTitle(series) {
  return (
    series?.titleEn ||
    series?.titleZh ||
    series?.titleJa ||
    series?.id ||
    ''
  );
}

/**
 * Normalize a raw dandanplay search hit to the rematch payload that the
 * service layer expects. Falls back to anilistId when dandanAnimeId is
 * missing (some search response shapes only carry one).
 *
 * @param {any} item
 * @returns {RematchPayload | null}
 */
function normalize(item) {
  if (!item) return null;
  const animeId = Number(item.dandanAnimeId ?? item.anilistId ?? NaN);
  if (!Number.isInteger(animeId) || animeId <= 0) return null;
  /** @type {RematchPayload['type']} */
  let type = 'tv';
  if (typeof item.format === 'string') {
    const f = item.format.toLowerCase();
    if (f.includes('movie')) type = 'movie';
    else if (f.includes('ova')) type = 'ova';
    else if (f.includes('web')) type = 'web';
  }
  return {
    animeId,
    titleZh: item.titleChinese || undefined,
    titleEn: item.title || undefined,
    posterUrl: item.coverImageUrl || item.imageUrl || undefined,
    type,
  };
}

/**
 * RematchDialog — pick a different dandanplay anime for an existing series.
 *
 * Wraps the existing ManualSearch picker in a modal shell. The picked item is
 * normalized into the shape rematchSeries() expects (animeId + display fields)
 * before being handed to onConfirm. Backdrop click + Escape + Cancel all close.
 *
 * @param {{
 *   open: boolean,
 *   sourceSeries: Series,
 *   onClose: () => void,
 *   onConfirm: (payload: RematchPayload) => void,
 * }} props
 */
export default function RematchDialog({
  open,
  sourceSeries,
  onClose,
  onConfirm,
}) {
  useEffect(() => {
    if (!open) return undefined;
    function onKey(e) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const sourceTitle = pickTitle(sourceSeries);

  function handleSelect(item) {
    const payload = normalize(item);
    if (payload) onConfirm(payload);
  }

  return (
    <div
      data-testid="rematch-dialog-backdrop"
      style={s.backdrop}
      onClick={onClose}
    >
      <div
        data-testid="rematch-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rematch-source-title"
        style={s.dialog}
        onClick={(e) => e.stopPropagation()}
      >
        <CornerBrackets inset={4} size={10} opacity={0.35} hue={HUE} />

        <div style={s.header}>
          <span style={s.kicker}>重新匹配系列</span>
          <span
            id="rematch-source-title"
            data-testid="rematch-source-title"
            style={s.title}
          >
            {sourceTitle}
          </span>
        </div>

        <div style={s.body}>
          <ManualSearch
            defaultKeyword={sourceTitle}
            onSelect={handleSelect}
            onBack={onClose}
          />
        </div>

        <div style={s.footer}>
          <button
            data-testid="rematch-cancel"
            type="button"
            style={s.cancelBtn}
            onClick={onClose}
          >
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

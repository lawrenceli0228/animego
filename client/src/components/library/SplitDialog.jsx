// @ts-check
import { useEffect, useMemo, useState } from 'react';
import { mono, PLAYER_HUE } from '../shared/hud-tokens';
import { CornerBrackets } from '../shared/hud';

/** @typedef {import('../../lib/library/types').Series} Series */
/** @typedef {import('../../lib/library/types').Season} Season */

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
    width: 'min(560px, 100%)',
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
  nameWrap: {
    padding: '12px 20px',
    borderBottom: `1px solid oklch(46% 0.06 ${HUE} / 0.20)`,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  fieldLabel: {
    ...mono,
    fontSize: 9,
    color: `rgba(235,235,245,0.55)`,
    textTransform: 'uppercase',
    letterSpacing: '0.18em',
  },
  nameInput: {
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
    padding: '8px 12px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  listLabel: {
    ...mono,
    padding: '8px 8px 4px',
    fontSize: 9,
    color: `rgba(235,235,245,0.55)`,
    textTransform: 'uppercase',
    letterSpacing: '0.18em',
  },
  season: (selected) => ({
    ...mono,
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 12px',
    background: selected
      ? `oklch(62% 0.17 ${HUE} / 0.20)`
      : `oklch(14% 0.04 ${HUE} / 0.55)`,
    border: `1px solid ${selected
      ? `oklch(62% 0.17 ${HUE} / 0.55)`
      : `oklch(46% 0.06 ${HUE} / 0.30)`}`,
    borderRadius: 3,
    color: '#fff',
    fontSize: 12,
    cursor: 'pointer',
    textAlign: 'left',
    width: '100%',
  }),
  checkbox: (selected) => ({
    width: 14,
    height: 14,
    border: `1px solid ${selected
      ? `oklch(72% 0.15 ${HUE})`
      : `oklch(46% 0.06 ${HUE} / 0.55)`}`,
    background: selected ? `oklch(62% 0.17 ${HUE})` : 'transparent',
    borderRadius: 2,
    flexShrink: 0,
  }),
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
  button: (primary, disabled) => ({
    ...mono,
    padding: '8px 16px',
    background: primary
      ? (disabled
        ? `oklch(40% 0.06 ${HUE} / 0.20)`
        : `oklch(62% 0.17 ${HUE} / 0.25)`)
      : 'transparent',
    border: `1px solid oklch(${primary ? '62% 0.17' : '46% 0.06'} ${HUE} / ${disabled ? '0.30' : '0.55'})`,
    borderRadius: 3,
    color: primary
      ? (disabled ? 'rgba(235,235,245,0.40)' : `oklch(75% 0.15 ${HUE})`)
      : 'rgba(235,235,245,0.85)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: '0.12em',
    opacity: disabled ? 0.6 : 1,
  }),
};

function pickTitle(series) {
  return series?.titleEn || series?.titleZh || series?.titleJa || series?.id || '';
}

function seasonLabel(season) {
  const num = season?.number != null ? `S${season.number}` : '';
  const hint = season?._titleHint ?? '';
  return [num, hint].filter(Boolean).join(' · ') || season?.id || '';
}

/**
 * SplitDialog — extract one or more seasons of a Series into a new Series.
 *
 * Disabling all-selected guards against the user effectively renaming the
 * source via the split UI; that's a different operation. Confirm fires with
 * the selected season ids and the new series name.
 *
 * @param {{
 *   open: boolean,
 *   sourceSeries: Series,
 *   seasons: Season[],
 *   onClose: () => void,
 *   onConfirm: (payload: { seasonIds: string[], name: string }) => void,
 * }} props
 */
export default function SplitDialog({
  open,
  sourceSeries,
  seasons,
  onClose,
  onConfirm,
}) {
  const [selected, setSelected] = useState(/** @type {Set<string>} */ (new Set()));
  const [name, setName] = useState('');

  useEffect(() => {
    if (!open) return undefined;
    function onKey(e) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Reset state on open so prior selections don't leak across invocations.
  useEffect(() => {
    if (open) {
      setSelected(new Set());
      setName('');
    }
  }, [open]);

  const orderedIds = useMemo(
    () => (Array.isArray(seasons) ? seasons.map((sn) => sn.id) : []),
    [seasons],
  );

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (!open) return null;

  const canSplit = Array.isArray(seasons) && seasons.length >= 2;
  const selectedIds = orderedIds.filter((id) => selected.has(id));
  const trimmedName = name.trim();
  // Disallow a "split everything" — that's a rename, not a split.
  const wouldExtractAll = canSplit && selectedIds.length === seasons.length;
  const confirmDisabled =
    !canSplit ||
    selectedIds.length === 0 ||
    wouldExtractAll ||
    trimmedName.length === 0;

  return (
    <div
      data-testid="split-dialog-backdrop"
      style={s.backdrop}
      onClick={onClose}
    >
      <div
        data-testid="split-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="split-source-title"
        style={s.dialog}
        onClick={(e) => e.stopPropagation()}
      >
        <CornerBrackets inset={4} size={10} opacity={0.35} hue={HUE} />

        <div style={s.header}>
          <span style={s.kicker}>拆分系列</span>
          <span
            id="split-source-title"
            data-testid="split-source-title"
            style={s.title}
          >
            {pickTitle(sourceSeries)}
          </span>
        </div>

        <div style={s.nameWrap}>
          <label style={s.fieldLabel} htmlFor="split-name-input">
            新系列名称
          </label>
          <input
            id="split-name-input"
            data-testid="split-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如:Re:Zero 第二季"
            style={s.nameInput}
          />
        </div>

        {!canSplit ? (
          <div data-testid="split-empty" style={s.empty}>
            源系列只有一个 season,无法拆分
          </div>
        ) : (
          <div style={s.list}>
            <span style={s.listLabel}>选择要拆出的 season</span>
            {seasons.map((sn) => {
              const isSel = selected.has(sn.id);
              return (
                <button
                  key={sn.id}
                  type="button"
                  data-testid={`split-season-${sn.id}`}
                  style={s.season(isSel)}
                  onClick={() => toggle(sn.id)}
                  aria-pressed={isSel}
                >
                  <span style={s.checkbox(isSel)} aria-hidden />
                  <span>{seasonLabel(sn)}</span>
                </button>
              );
            })}
          </div>
        )}

        <div style={s.footer}>
          <button
            data-testid="split-cancel"
            type="button"
            style={s.button(false, false)}
            onClick={onClose}
          >
            取消
          </button>
          <button
            data-testid="split-confirm"
            type="button"
            style={s.button(true, confirmDisabled)}
            disabled={confirmDisabled}
            onClick={() =>
              onConfirm({ seasonIds: selectedIds, name: trimmedName })
            }
          >
            拆分
          </button>
        </div>
      </div>
    </div>
  );
}

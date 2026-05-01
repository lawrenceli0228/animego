// @ts-check
import { mono } from '../shared/hud-tokens';

/** @typedef {import('../../lib/library/types').HandleRecord} HandleRecord */

const s = {
  banner: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '10px 14px',
    background: 'oklch(20% 0.05 25 / 0.55)',
    border: '1px solid oklch(60% 0.20 25 / 0.45)',
    borderRadius: 4,
  },
  glyph: {
    ...mono,
    fontSize: 16,
    color: 'oklch(78% 0.18 25)',
    lineHeight: 1,
    flexShrink: 0,
  },
  body: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  title: {
    ...mono,
    fontSize: 11,
    color: '#fff',
    fontWeight: 600,
    letterSpacing: '0.10em',
    textTransform: 'uppercase',
  },
  hint: {
    ...mono,
    fontSize: 10,
    color: 'rgba(235,235,245,0.55)',
    letterSpacing: '0.05em',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  cta: {
    ...mono,
    padding: '6px 12px',
    background: 'oklch(60% 0.20 25 / 0.20)',
    border: '1px solid oklch(60% 0.20 25 / 0.55)',
    borderRadius: 3,
    color: 'oklch(78% 0.18 25)',
    fontSize: 10,
    cursor: 'pointer',
    textTransform: 'uppercase',
    letterSpacing: '0.12em',
    flexShrink: 0,
  },
};

/**
 * Offline drives banner — shown above the library grid when one or more
 * persisted root handles probe as 'disconnected' (drive unplugged).
 *
 * Click "重试" to re-probe; the parent runs `refresh` which re-classifies
 * each handle. If the user has reconnected the drive in the meantime, the
 * banner disappears.
 *
 * @param {{
 *   roots: HandleRecord[],
 *   offlineLibraryIds: string[],
 *   onRetry: () => void,
 * }} props
 */
export default function LibraryOfflineBanner({ roots, offlineLibraryIds, onRetry }) {
  if (!offlineLibraryIds.length) return null;

  const offlineNames = offlineLibraryIds
    .map((libId) => roots.find((r) => r.libraryId === libId)?.name)
    .filter(Boolean);

  const summary = offlineNames.length === 1
    ? `"${offlineNames[0]}" 未连接`
    : `${offlineLibraryIds.length} 个硬盘未连接`;

  const namesLine = offlineNames.length > 1
    ? offlineNames.map((n) => `"${n}"`).join(' · ')
    : '请重新接入硬盘后点"重试"';

  return (
    <div
      style={s.banner}
      data-testid="library-offline-banner"
      data-count={offlineLibraryIds.length}
    >
      <span style={s.glyph} aria-hidden>⊘</span>
      <div style={s.body}>
        <span style={s.title}>{summary}</span>
        <span style={s.hint}>{namesLine}</span>
      </div>
      <button
        type="button"
        style={s.cta}
        onClick={onRetry}
        data-testid="library-offline-retry"
      >
        重试
      </button>
    </div>
  );
}

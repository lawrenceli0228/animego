// @ts-check
import { useLang } from '../../context/LanguageContext';
import { mono } from '../shared/hud-tokens';

const AMBER_HUE = 40;

const s = {
  banner: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '10px 16px',
    background: `oklch(62% 0.17 ${AMBER_HUE} / 0.15)`,
    border: `1px solid oklch(62% 0.17 ${AMBER_HUE} / 0.45)`,
    borderRadius: 4,
  },
  text: {
    ...mono,
    fontSize: 11,
    color: `oklch(72% 0.15 ${AMBER_HUE})`,
    letterSpacing: '0.05em',
  },
  dismiss: {
    ...mono,
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    color: `oklch(72% 0.15 ${AMBER_HUE} / 0.70)`,
    fontSize: 14,
    padding: '0 4px',
    lineHeight: 1,
  },
};

/**
 * FsaUnsupportedBanner — amber warning when the File System Access API is absent.
 *
 * @param {{
 *   onDismiss?: () => void,
 * }} props
 */
export default function FsaUnsupportedBanner({ onDismiss }) {
  const { t } = useLang();

  return (
    <div style={s.banner} role="alert">
      <span style={s.text}>{t('library.unsupportedBanner')}</span>
      {onDismiss && (
        <button
          style={s.dismiss}
          onClick={onDismiss}
          type="button"
          aria-label="Dismiss"
        >
          ×
        </button>
      )}
    </div>
  );
}

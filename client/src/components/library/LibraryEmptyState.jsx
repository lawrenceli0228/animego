// @ts-check
import { useLang } from '../../context/LanguageContext';
import { mono, PLAYER_HUE } from '../shared/hud-tokens';
import PrivacyHint from '../shared/PrivacyHint';

const HUE = PLAYER_HUE.ingest;

const s = {
  wrapper: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 20,
    padding: '64px 24px',
    border: `2px dashed oklch(46% 0.06 ${HUE} / 0.40)`,
    borderRadius: 4,
    background: `oklch(14% 0.04 ${HUE} / 0.30)`,
  },
  hint: {
    ...mono,
    fontSize: 11,
    color: `rgba(235,235,245,0.45)`,
    textAlign: 'center',
    textTransform: 'uppercase',
    letterSpacing: '0.15em',
  },
  addBtn: {
    ...mono,
    padding: '10px 20px',
    background: `oklch(62% 0.17 ${HUE} / 0.20)`,
    border: `1px solid oklch(62% 0.17 ${HUE} / 0.55)`,
    borderRadius: 4,
    color: `oklch(72% 0.15 ${HUE})`,
    cursor: 'pointer',
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: '0.12em',
    transition: 'background 150ms ease-out',
  },
};

/**
 * LibraryEmptyState — shown when the library has no series yet.
 *
 * @param {{
 *   onAddFolder: () => void,
 *   isFsaSupported: boolean,
 * }} props
 */
export default function LibraryEmptyState({ onAddFolder, isFsaSupported }) {
  const { t } = useLang();

  return (
    <div style={s.wrapper}>
      <p style={s.hint}>
        {isFsaSupported ? t('library.noSeries') : t('library.dropFolder')}
      </p>
      {isFsaSupported && (
        <button style={s.addBtn} onClick={onAddFolder} type="button">
          {t('library.addFolder')}
        </button>
      )}
      <PrivacyHint />
    </div>
  );
}

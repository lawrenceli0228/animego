// @ts-check
import { useState } from 'react';
import { useLang } from '../../context/LanguageContext';
import { mono, PLAYER_HUE } from '../shared/hud-tokens';
import { CornerBrackets } from '../shared/hud';

const HUE = PLAYER_HUE.local;

const s = {
  wrapper: {
    position: 'relative',
    maxWidth: 640,
    margin: '64px auto',
    padding: '48px 56px',
    background: `linear-gradient(180deg, oklch(14% 0.04 ${HUE} / 0.55) 0%, rgba(20,20,22,0.55) 100%)`,
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.36)`,
    borderRadius: 4,
    textAlign: 'center',
  },
  eyebrow: {
    ...mono,
    fontSize: 10,
    color: `oklch(72% 0.15 ${HUE} / 0.85)`,
    letterSpacing: '0.20em',
    textTransform: 'uppercase',
    marginBottom: 14,
  },
  eyebrowDenied: {
    color: 'oklch(72% 0.18 30 / 0.95)',
  },
  title: {
    fontFamily: "'Sora',sans-serif",
    fontWeight: 600,
    fontSize: 22,
    color: '#fff',
    letterSpacing: '-0.01em',
    lineHeight: 1.3,
    marginBottom: 12,
  },
  body: {
    fontSize: 14,
    color: 'rgba(235,235,245,0.55)',
    lineHeight: 1.55,
    marginBottom: 28,
    fontFamily: "'JetBrains Mono',monospace",
    letterSpacing: '0.02em',
  },
  actions: {
    display: 'flex',
    gap: 12,
    justifyContent: 'center',
    flexWrap: 'wrap',
  },
  btn: (hover, primary) => ({
    background: primary
      ? hover
        ? `oklch(62% 0.19 ${HUE} / 0.30)`
        : `oklch(62% 0.19 ${HUE} / 0.18)`
      : hover
        ? `oklch(62% 0.19 ${HUE} / 0.10)`
        : 'transparent',
    border: `1px solid oklch(${primary ? 62 : 46}% ${primary ? 0.19 : 0.06} ${HUE} / ${primary ? (hover ? 0.85 : 0.65) : (hover ? 0.65 : 0.40)})`,
    borderRadius: 2,
    padding: '10px 18px',
    fontFamily: "'JetBrains Mono',monospace",
    fontSize: 11,
    fontWeight: 500,
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    color: hover ? '#fff' : primary ? `oklch(82% 0.15 ${HUE})` : 'rgba(235,235,245,0.75)',
    cursor: 'pointer',
    transition: 'all 150ms cubic-bezier(0.16,1,0.3,1)',
  }),
};

/**
 * @typedef {'loading'|'missing'|'error'|'denied'} EmptyKind
 */

function HudButton({ onClick, label, primary, testId }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={s.btn(hover, !!primary)}
      data-testid={testId}
    >
      {label}
    </button>
  );
}

/**
 * Empty state shown on PlayerPage when a library entry can't open — series
 * record gone, FSA permission revoked, or transient load error. The denied
 * path is the most common (browser restart loses transient handle grants),
 * so it gets the primary CTA.
 *
 * @param {{
 *   kind: EmptyKind,
 *   onReauthorize?: () => void,
 *   onRetry?: () => void,
 *   onBackToLibrary: () => void,
 * }} props
 */
export default function LibraryAccessEmpty({ kind, onReauthorize, onRetry, onBackToLibrary }) {
  const { t } = useLang();

  const eyebrow = {
    loading: t('library.access.loadingEyebrow'),
    missing: t('library.access.missingEyebrow'),
    error: t('library.access.errorEyebrow'),
    denied: t('library.access.deniedEyebrow'),
  }[kind];

  const title = {
    loading: t('library.access.loadingTitle'),
    missing: t('library.access.missingTitle'),
    error: t('library.access.errorTitle'),
    denied: t('library.access.deniedTitle'),
  }[kind];

  const body = {
    loading: t('library.access.loadingBody'),
    missing: t('library.access.missingBody'),
    error: t('library.access.errorBody'),
    denied: t('library.access.deniedBody'),
  }[kind];

  return (
    <div style={s.wrapper} data-testid="library-access-empty" data-kind={kind}>
      <CornerBrackets inset={6} size={8} opacity={0.32} hue={HUE} />
      <div style={{ ...s.eyebrow, ...(kind === 'denied' ? s.eyebrowDenied : null) }}>
        {eyebrow}
      </div>
      <div style={s.title}>{title}</div>
      <div style={s.body}>{body}</div>
      {kind !== 'loading' && (
        <div style={s.actions}>
          {kind === 'denied' && onReauthorize && (
            <HudButton
              onClick={onReauthorize}
              label={t('library.access.reauthorize')}
              primary
              testId="library-access-reauthorize"
            />
          )}
          {kind === 'error' && onRetry && (
            <HudButton
              onClick={onRetry}
              label={t('library.access.retry')}
              primary
              testId="library-access-retry"
            />
          )}
          <HudButton
            onClick={onBackToLibrary}
            label={t('library.access.backToLibrary')}
            testId="library-access-back"
          />
        </div>
      )}
    </div>
  );
}

import { motion as Motion, useReducedMotion } from 'motion/react';
import { useLang } from '../../context/LanguageContext';
import { ChapterBar, CornerBrackets } from '../shared/hud';
import { mono, PLAYER_HUE } from '../shared/hud-tokens';

const HUE = PLAYER_HUE.status;
const HUE_DONE = PLAYER_HUE.live;

const STATUS_COLOR = {
  pending: 'rgba(235,235,245,0.30)',
  active: `oklch(72% 0.15 ${HUE})`,
  done: `oklch(62% 0.19 ${HUE_DONE})`,
  fail: '#ff453a',
};

const s = {
  container: {
    position: 'relative',
    background: `linear-gradient(180deg, oklch(14% 0.04 ${HUE} / 0.55) 0%, rgba(20,20,22,0.55) 100%)`,
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.36)`,
    borderRadius: 4,
    padding: '24px 28px 28px 56px',
    maxWidth: 600, margin: '0 auto',
  },
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: 24,
  },
  headerText: {
    ...mono,
    fontSize: 11, color: 'rgba(235,235,245,0.85)',
    textTransform: 'uppercase', letterSpacing: '0.16em',
  },
  clearBtn: {
    ...mono,
    background: 'transparent',
    border: '1px solid rgba(235,235,245,0.20)',
    borderRadius: 2,
    padding: '6px 14px',
    fontSize: 11,
    color: 'rgba(235,235,245,0.75)',
    cursor: 'pointer',
    textTransform: 'uppercase', letterSpacing: '0.14em',
  },
  steps: { position: 'relative' },
  // Vertical connector chapter bar — sits inside the steps area, behind the icons.
  connector: {
    position: 'absolute',
    left: 19, top: 12, bottom: 12,
    width: 2,
    background: `oklch(46% 0.06 ${HUE} / 0.30)`,
  },
  // Step row — must keep height: 40 so existing queries (`div[style*="height: 40px"]`) stay valid.
  step: (status) => ({
    position: 'relative',
    display: 'flex', alignItems: 'center', gap: 14,
    height: 40, fontSize: 14,
    paddingLeft: 6,
    color: status === 'active' ? `oklch(78% 0.15 ${HUE})`
         : status === 'done' ? '#ffffff'
         : status === 'fail' ? 'rgba(235,235,245,0.60)'
         : 'rgba(235,235,245,0.30)',
  }),
  stepNum: (status) => ({
    ...mono,
    fontSize: 10,
    width: 28, flexShrink: 0,
    color: status === 'active' ? `oklch(78% 0.15 ${HUE})` : 'rgba(235,235,245,0.32)',
    letterSpacing: '0.10em',
  }),
  stepIcon: (status) => ({
    width: 24, textAlign: 'center', fontSize: 16, flexShrink: 0,
    color: STATUS_COLOR[status],
    fontFamily: "'JetBrains Mono', monospace",
    lineHeight: 1,
    display: 'inline-flex', justifyContent: 'center', alignItems: 'center',
  }),
  stepText: (status) => ({
    ...mono,
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: '0.14em',
    color: status === 'active' ? `oklch(78% 0.15 ${HUE})`
         : status === 'done' ? '#ffffff'
         : status === 'fail' ? 'rgba(235,235,245,0.60)'
         : 'rgba(235,235,245,0.30)',
  }),
};

const STATUS_ICON = {
  pending: '○',  // preserved char (existing test asserts toBe('○'))
  active: '◑',
  done: '●',
  fail: '✕',
};

/**
 * StepIcon — renders the status glyph with motion:
 *   #5 active step spins (◑)
 *   #6 done step scales-in with spring (●)
 */
function StepIcon({ status }) {
  const reduced = useReducedMotion();
  const glyph = STATUS_ICON[status] || '○';

  if (status === 'active' && !reduced) {
    return (
      <Motion.span
        style={s.stepIcon(status)}
        animate={{ rotate: 360 }}
        transition={{ duration: 1.6, repeat: Infinity, ease: 'linear' }}
        aria-hidden
      >
        {glyph}
      </Motion.span>
    );
  }

  if (status === 'done' && !reduced) {
    return (
      <Motion.span
        style={s.stepIcon(status)}
        initial={{ scale: 0.4, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 360, damping: 18 }}
        aria-hidden
      >
        {glyph}
      </Motion.span>
    );
  }

  return <span style={s.stepIcon(status)}>{glyph}</span>;
}

/**
 * StepRow — single row. Active step gets CornerBrackets wrapping it.
 */
function StepRow({ index, status, label, detail }) {
  const numStr = `[${String(index).padStart(2, '0')}]`;
  return (
    <div style={s.step(status)} aria-live={status === 'active' ? 'polite' : undefined}>
      {status === 'active' && (
        <CornerBrackets inset={2} size={6} opacity={0.5} hue={HUE} />
      )}
      {/* Icon FIRST — preserves prior DOM order so legacy tests querying
          `div[style*="height: 40px"] span` find the status glyph at index 0. */}
      <StepIcon status={status} />
      <span style={s.stepNum(status)} aria-hidden>{numStr}</span>
      <span style={s.stepText(status)}>
        {label}
        {status === 'done' && detail ? ` — ${detail}` : ''}
        {status === 'active' && ' ...'}
      </span>
    </div>
  );
}

export default function MatchProgress({ fileCount, keyword, stepStatus, onClear }) {
  const { t } = useLang();

  const steps = [
    { key: 1, label: t('player.stepParse'), detail: `${fileCount} ${t('player.videos')}, ${t('player.keyword')}: "${keyword}"` },
    { key: 2, label: t('player.stepMatch'), detail: '' },
    { key: 3, label: t('player.stepMap'), detail: '' },
  ];

  return (
    <div style={s.container}>
      <ChapterBar hue={HUE} height={48} top={20} left={20} trigger="mount" />
      <CornerBrackets inset={6} size={8} opacity={0.30} />

      <div style={s.header}>
        <span style={s.headerText}>
          {t('player.loaded')}: {fileCount} {t('player.videos')}
        </span>
        <button style={s.clearBtn} onClick={onClear}>{t('player.clear')}</button>
      </div>

      <div style={s.steps}>
        <span style={s.connector} aria-hidden />
        {steps.map(({ key, label, detail }, i) => {
          const status = stepStatus[key] || 'pending';
          return (
            <StepRow
              key={key}
              index={i + 1}
              status={status}
              label={label}
              detail={detail}
            />
          );
        })}
      </div>
    </div>
  );
}

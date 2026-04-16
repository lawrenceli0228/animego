import { useLang } from '../../context/LanguageContext';

const s = {
  container: {
    background: '#1c1c1e', borderRadius: 12, padding: 24,
    maxWidth: 600, margin: '0 auto',
  },
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: 20,
  },
  headerText: { fontSize: 14, fontWeight: 500, color: '#ffffff' },
  clearBtn: {
    background: 'rgba(120,120,128,0.12)', border: 'none', borderRadius: 8,
    padding: '6px 14px', fontSize: 14, fontWeight: 500,
    color: '#0a84ff', cursor: 'pointer',
  },
  step: {
    display: 'flex', alignItems: 'center', gap: 12,
    height: 40, fontSize: 14,
  },
  icon: (status) => ({
    width: 24, textAlign: 'center', fontSize: 16, flexShrink: 0,
    color: status === 'done' ? '#30d158'
         : status === 'fail' ? '#ff453a'
         : status === 'active' ? '#0a84ff'
         : 'rgba(235,235,245,0.18)',
  }),
  text: (status) => ({
    color: status === 'active' ? '#0a84ff'
         : status === 'done' ? '#ffffff'
         : status === 'fail' ? 'rgba(235,235,245,0.60)'
         : 'rgba(235,235,245,0.30)',
  }),
};

const STATUS_ICON = {
  pending: '○',
  active: '◌',
  done: '✓',
  fail: '✕',
};

export default function MatchProgress({ fileCount, keyword, stepStatus, onClear }) {
  const { t } = useLang();

  const steps = [
    { key: 1, label: t('player.stepParse'), detail: `${fileCount} ${t('player.videos')}, ${t('player.keyword')}: "${keyword}"` },
    { key: 2, label: t('player.stepMatch'), detail: '' },
    { key: 3, label: t('player.stepMap'), detail: '' },
  ];

  return (
    <div style={s.container}>
      <div style={s.header}>
        <span style={s.headerText}>
          {t('player.loaded')}: {fileCount} {t('player.videos')}
        </span>
        <button style={s.clearBtn} onClick={onClear}>{t('player.clear')}</button>
      </div>

      {steps.map(({ key, label, detail }) => {
        const status = stepStatus[key] || 'pending';
        return (
          <div key={key} style={s.step} aria-live={status === 'active' ? 'polite' : undefined}>
            <span style={s.icon(status)}>{STATUS_ICON[status]}</span>
            <span style={s.text(status)}>
              {label}
              {status === 'done' && detail ? ` — ${detail}` : ''}
              {status === 'active' && ' ...'}
            </span>
          </div>
        );
      })}
    </div>
  );
}

import { useLang } from '../../context/LanguageContext';

const s = {
  container: { maxWidth: 1100, margin: '0 auto' },
  animeInfo: {
    display: 'flex', gap: 24, marginBottom: 28, alignItems: 'flex-start',
  },
  cover: {
    width: 160, height: 224, borderRadius: 10, objectFit: 'cover',
    background: '#2c2c2e', flexShrink: 0,
  },
  info: { flex: 1, minWidth: 0 },
  title: {
    fontFamily: "'Sora',sans-serif", fontWeight: 600,
    fontSize: 24, color: '#ffffff', letterSpacing: '-0.02em',
  },
  titleCn: {
    fontSize: 16, color: 'rgba(235,235,245,0.60)', marginTop: 4,
  },
  meta: {
    fontSize: 14, color: 'rgba(235,235,245,0.30)', marginTop: 8,
  },
  badge: {
    display: 'inline-block', padding: '2px 8px', borderRadius: 9999,
    background: 'rgba(90,200,250,0.10)', color: '#5ac8fa',
    fontSize: 13, fontWeight: 500, marginTop: 8,
  },
  headerActions: { display: 'flex', flexDirection: 'column', gap: 8, alignSelf: 'flex-start' },
  clearBtn: {
    background: 'rgba(120,120,128,0.12)', border: 'none', borderRadius: 8,
    padding: '6px 14px', fontSize: 14, fontWeight: 500,
    color: '#0a84ff', cursor: 'pointer',
  },
  rematchHeaderBtn: {
    background: 'none', border: '1px solid rgba(84,84,88,0.65)', borderRadius: 8,
    padding: '6px 14px', fontSize: 13, fontWeight: 500,
    color: 'rgba(235,235,245,0.60)', cursor: 'pointer',
  },
  row: (i) => ({
    display: 'flex', alignItems: 'center', gap: 14,
    minHeight: 56, padding: '10px 20px', borderRadius: 8,
    background: i % 2 === 1 ? 'rgba(120,120,128,0.06)' : 'transparent',
    transition: 'background 150ms', cursor: 'pointer',
  }),
  epNum: { fontWeight: 600, fontSize: 15, color: '#ffffff', width: 52, flexShrink: 0, alignSelf: 'flex-start', paddingTop: 3 },
  fileInfo: { flex: 1, minWidth: 0 },
  fileName: {
    fontSize: 15, color: 'rgba(235,235,245,0.60)',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  epTitle: {
    fontSize: 13, fontWeight: 600, color: 'rgba(235,235,245,0.35)', marginTop: 3,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  playIcon: (hover) => ({
    fontSize: 20, color: hover ? '#0a84ff' : 'rgba(235,235,245,0.30)',
    flexShrink: 0, transition: 'color 150ms',
  }),
  unmatchedSection: {
    marginTop: 16, paddingTop: 16,
    borderTop: '1px solid rgba(84,84,88,0.65)',
  },
  unmatchedLabel: {
    fontSize: 13, color: 'rgba(235,235,245,0.30)', marginBottom: 8,
  },
  unmatchedFile: {
    fontSize: 13, color: 'rgba(235,235,245,0.18)', padding: '4px 0',
  },
  rematchBtn: {
    background: 'none', border: '1px solid rgba(84,84,88,0.65)', borderRadius: 8,
    padding: '6px 14px', fontSize: 13, fontWeight: 500,
    color: 'rgba(235,235,245,0.60)', cursor: 'pointer', marginTop: 8,
  },
};

export default function EpisodeFileList({ anime, episodeMap, videoFiles, onPlay, onClear, onRematch }) {
  const { t } = useLang();

  const matched = videoFiles.filter(f => f.episode != null && episodeMap[f.episode]);
  const unmatched = videoFiles.filter(f => f.episode == null || !episodeMap[f.episode]);

  return (
    <div style={s.container}>
      {/* Anime info header */}
      <div style={s.animeInfo}>
        {anime.coverImageUrl && (
          <img style={s.cover} src={anime.coverImageUrl} alt="" />
        )}
        <div style={s.info}>
          <div style={s.title}>{anime.titleNative || anime.titleRomaji}</div>
          {anime.titleChinese && <div style={s.titleCn}>{anime.titleChinese}</div>}
          <div style={s.meta}>
            {anime.episodes && `${anime.episodes}${t('detail.epUnit')}`}
          </div>
          <div style={s.badge}>dandanplay · {Object.keys(episodeMap).length} {t('player.mapped')}</div>
        </div>
        <div style={s.headerActions}>
          <button style={s.rematchHeaderBtn} onClick={onRematch}>{t('player.rematch')}</button>
          <button style={s.clearBtn} onClick={onClear}>✕ {t('player.clear')}</button>
        </div>
      </div>

      {/* Episode list */}
      {matched.map((f, i) => (
        <EpisodeRow
          key={f.fileName}
          index={i}
          episode={f.episode}
          fileName={f.fileName}
          episodeTitle={episodeMap[f.episode]?.title}
          onPlay={() => onPlay(f)}
        />
      ))}

      {/* Unmatched files */}
      {unmatched.length > 0 && (
        <div style={s.unmatchedSection}>
          <div style={s.unmatchedLabel}>
            {t('player.unmatched')}: {unmatched.map(f => f.fileName).join(', ')}
          </div>
        </div>
      )}
    </div>
  );
}

function EpisodeRow({ index, episode, fileName, episodeTitle, onPlay }) {
  return (
    <div
      style={s.row(index)}
      onClick={onPlay}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onPlay(); }}
      onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(10,132,255,0.12)'}
      onMouseLeave={(e) => e.currentTarget.style.background = index % 2 === 1 ? 'rgba(120,120,128,0.06)' : 'transparent'}
    >
      <span style={s.epNum}>EP{String(episode).padStart(2, '0')}</span>
      <div style={s.fileInfo}>
        <div style={s.fileName}>{fileName}</div>
        {episodeTitle && <div style={s.epTitle}>{episodeTitle}</div>}
      </div>
      <span style={s.playIcon(false)}>▶</span>
    </div>
  );
}

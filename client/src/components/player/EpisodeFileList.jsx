import { useState } from 'react';
import { motion as Motion, useReducedMotion } from 'motion/react';
import { useLang } from '../../context/LanguageContext';
import { formatScore } from '../../utils/formatters';
import { ChapterBar, CornerBrackets } from '../shared/hud';
import { mono, PLAYER_HUE } from '../shared/hud-tokens';

const HUE = PLAYER_HUE.stream;

const scoreColor = (v) => v >= 75 ? '#30d158' : v >= 50 ? '#ff9f0a' : '#ff453a';

const SOURCE_LABEL = {
  ORIGINAL: { zh: '原创', en: 'Original' },
  MANGA: { zh: '漫改', en: 'Manga' },
  LIGHT_NOVEL: { zh: '轻小说改', en: 'Light Novel' },
  VISUAL_NOVEL: { zh: '视觉小说改', en: 'Visual Novel' },
  VIDEO_GAME: { zh: '游戏改', en: 'Video Game' },
  NOVEL: { zh: '小说改', en: 'Novel' },
  WEB_NOVEL: { zh: '网文改', en: 'Web Novel' },
  GAME: { zh: '游戏改', en: 'Game' },
};

// OKLCH per-episode hue rotation: 210, 220, 230, ... cycles through the spectrum.
const epHue = (ep) => 210 + (ep != null ? (ep * 10) % 360 : 0);

const s = {
  container: { maxWidth: 1100, margin: '0 auto' },
  animeInfo: {
    display: 'flex', gap: 24, marginBottom: 28, alignItems: 'flex-start',
  },
  cover: {
    width: 160, aspectRatio: '3/4', borderRadius: 12, objectFit: 'cover',
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
  // Site anime info styles
  siteInfo: {
    marginTop: 14, paddingTop: 14,
    borderTop: '1px solid rgba(84,84,88,0.36)',
  },
  badgeRow: { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  scoreBadge: (color) => ({
    padding: '3px 10px', borderRadius: 9999, background: 'rgba(255,159,10,0.12)',
    color, fontWeight: 700, fontSize: 12, fontFamily: "'JetBrains Mono',monospace",
  }),
  bgmScoreBadge: {
    padding: '3px 10px', borderRadius: 9999, background: 'rgba(255,69,58,0.10)',
    color: '#ff453a', fontWeight: 700, fontSize: 12,
    display: 'inline-flex', alignItems: 'center', gap: 4,
    fontFamily: "'JetBrains Mono',monospace",
  },
  bgmLabel: { fontSize: 9, opacity: 0.7, fontFamily: "'DM Sans',sans-serif" },
  bgmVotes: { fontSize: 10, opacity: 0.6, fontWeight: 400 },
  infoBadge: (bg, color) => ({
    padding: '3px 10px', borderRadius: 9999, background: bg, color, fontSize: 12,
  }),
  metaRow: {
    display: 'flex', flexWrap: 'wrap', gap: '3px 10px', marginBottom: 10,
    alignItems: 'center',
  },
  metaStudio: { color: 'rgba(235,235,245,0.75)', fontSize: 12 },
  metaDot: { color: 'rgba(84,84,88,0.65)', fontSize: 12 },
  metaDetail: { color: 'rgba(235,235,245,0.50)', fontSize: 11 },
  genreRow: { display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 10 },
  genreTag: {
    padding: '3px 8px', borderRadius: 9999,
    background: 'rgba(120,120,128,0.12)', color: 'rgba(235,235,245,0.60)',
    fontSize: 11, fontWeight: 500,
  },
  detailBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '5px 14px', borderRadius: 8, cursor: 'pointer',
    background: 'rgba(10,132,255,0.12)', border: '1px solid rgba(10,132,255,0.3)',
    color: '#0a84ff', fontSize: 13, fontWeight: 500,
    transition: 'all 0.2s', textDecoration: 'none',
  },
  headerActions: { display: 'flex', flexDirection: 'column', gap: 8, alignSelf: 'flex-start' },
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
  // HUD row: relative for ChapterBar + CornerBrackets fade-in.
  row: (i, hover) => ({
    position: 'relative',
    display: 'flex', alignItems: 'center', gap: 14,
    minHeight: 56, padding: '12px 22px 12px 24px', borderRadius: 2,
    background: hover
      ? 'rgba(10,132,255,0.10)'
      : i % 2 === 1 ? 'rgba(120,120,128,0.05)' : 'transparent',
    transition: 'background 150ms, border-color 150ms',
    cursor: 'pointer',
    borderLeft: hover
      ? `2px solid oklch(62% 0.19 ${HUE} / 0.85)`
      : '2px solid transparent',
  }),
  // Per-episode badge — OKLCH hue rotated per episode number.
  epBadge: (ep) => ({
    ...mono,
    fontSize: 11,
    width: 64,
    flexShrink: 0,
    color: ep != null
      ? `oklch(78% 0.15 ${epHue(ep)})`
      : 'rgba(235,235,245,0.30)',
    letterSpacing: '0.10em',
    fontWeight: 600,
    paddingTop: 3,
    alignSelf: 'flex-start',
  }),
  fileInfo: { flex: 1, minWidth: 0 },
  fileName: {
    fontFamily: "'Sora',sans-serif",
    fontSize: 15, color: 'rgba(235,235,245,0.70)',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  epTitle: {
    fontSize: 12, fontWeight: 500, color: 'rgba(235,235,245,0.42)', marginTop: 4,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    fontFamily: "'JetBrains Mono',monospace", letterSpacing: '0.04em',
  },
  playIcon: (hover) => ({
    ...mono,
    fontSize: 11,
    color: hover ? `oklch(78% 0.15 ${HUE})` : 'rgba(235,235,245,0.30)',
    flexShrink: 0, transition: 'color 150ms',
    textTransform: 'uppercase', letterSpacing: '0.14em',
  }),
};

const danmakuBtnStyle = (hover) => ({
  background: 'transparent',
  border: `1px solid ${hover ? 'rgba(255,159,10,0.55)' : 'rgba(255,159,10,0.22)'}`,
  borderRadius: 2,
  cursor: 'pointer',
  padding: '5px 8px',
  fontSize: 11,
  color: hover ? 'oklch(78% 0.15 30)' : 'rgba(235,235,245,0.55)',
  flexShrink: 0,
  transition: 'all 150ms',
  fontFamily: "'JetBrains Mono',monospace",
  letterSpacing: '0.10em',
});

export default function EpisodeFileList({ anime, siteAnime, episodeMap, videoFiles, onPlay, onClear, onSetDanmaku }) {
  const { t, lang } = useLang();

  const sa = siteAnime;
  const statusLabel = sa?.status ? ({
    RELEASING: t('detail.releasing'), FINISHED: t('detail.finished'),
    NOT_YET_RELEASED: t('detail.notYetReleased'), CANCELLED: t('detail.cancelled'),
  }[sa.status] || sa.status) : null;

  const sourceLabel = sa?.source ? (SOURCE_LABEL[sa.source]?.[lang] ?? null) : null;
  const durationLabel = sa?.duration ? (lang === 'zh' ? `${sa.duration}分/集` : `${sa.duration} min/ep`) : null;

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

          {/* Site anime info */}
          {sa && (
            <div style={s.siteInfo}>
              {/* Score + info badges */}
              <div style={s.badgeRow}>
                {sa.averageScore > 0 && (
                  <span style={s.scoreBadge(scoreColor(sa.averageScore))}>
                    ★ {formatScore(sa.averageScore)}
                  </span>
                )}
                {sa.bangumiScore > 0 && (
                  <span style={s.bgmScoreBadge}>
                    <span style={s.bgmLabel}>BGM</span>
                    ★ {sa.bangumiScore.toFixed(1)}
                    {sa.bangumiVotes > 0 && <span style={s.bgmVotes}>({sa.bangumiVotes.toLocaleString()})</span>}
                  </span>
                )}
                {sa.format && <span style={s.infoBadge('rgba(10,132,255,0.12)', '#0a84ff')}>{sa.format}</span>}
                {statusLabel && <span style={s.infoBadge('rgba(90,200,250,0.10)', '#5ac8fa')}>{statusLabel}</span>}
                {sa.episodes > 0 && (
                  <span style={s.infoBadge('rgba(120,120,128,0.12)', 'rgba(235,235,245,0.60)')}>
                    {sa.episodes} {t('detail.epUnit')}
                  </span>
                )}
                {sa.season && sa.seasonYear && (
                  <span style={s.infoBadge('rgba(120,120,128,0.12)', 'rgba(235,235,245,0.60)')}>
                    {t(`season.${sa.season}`)} {sa.seasonYear}
                  </span>
                )}
              </div>

              {/* Studios + meta */}
              {(sa.studios?.length > 0 || sourceLabel || durationLabel) && (
                <div style={s.metaRow}>
                  {sa.studios?.length > 0 && <span style={s.metaStudio}>{sa.studios.join(' · ')}</span>}
                  {sa.studios?.length > 0 && (sourceLabel || durationLabel) && <span style={s.metaDot}>·</span>}
                  {sourceLabel && <span style={s.metaDetail}>{sourceLabel}</span>}
                  {durationLabel && <span style={s.metaDetail}>{durationLabel}</span>}
                </div>
              )}

              {/* Genres */}
              {sa.genres?.length > 0 && (
                <div style={s.genreRow}>
                  {sa.genres.map(g => <span key={g} style={s.genreTag}>{g}</span>)}
                </div>
              )}

              {/* View detail button */}
              {sa.anilistId && (
                <a
                  href={`/anime/${sa.anilistId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={s.detailBtn}
                  onMouseEnter={e => { e.currentTarget.style.background = 'rgba(10,132,255,0.20)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'rgba(10,132,255,0.12)' }}
                >
                  {t('detail.viewDetails')} →
                </a>
              )}
            </div>
          )}
        </div>
        <div style={s.headerActions}>
          <button style={s.clearBtn} onClick={onClear}>// {t('player.clear')}</button>
        </div>
      </div>

      {/* Episode list — all files playable, matched ones show episode title */}
      {videoFiles.map((f, i) => (
        <EpisodeRow
          key={f.fileId || f.fileName}
          index={i}
          episode={f.episode}
          fileName={f.fileName}
          episodeTitle={episodeMap[f.episode]?.title}
          onPlay={() => onPlay(f)}
          onSetDanmaku={() => onSetDanmaku(f.episode)}
        />
      ))}
    </div>
  );
}

/**
 * EpisodeRow — HUD row.
 *   - Left edge: 2px OKLCH border on hover (Motion #7)
 *   - 4 corner brackets fade in on hover (Motion #7, 150ms)
 *   - Per-episode hue rotation on the EPxx badge
 */
function EpisodeRow({ index, episode, fileName, episodeTitle, onPlay, onSetDanmaku }) {
  const reduced = useReducedMotion();
  const [hover, setHover] = useState(false);
  const [dmHover, setDmHover] = useState(false);
  const epLabel = episode != null ? `EP${String(episode).padStart(2, '0')}` : '—';
  return (
    <div
      style={s.row(index, hover)}
      onClick={onPlay}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onPlay(); }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <CornerBrackets
        show={hover}
        animate={!reduced}
        inset={4}
        size={8}
        opacity={0.4}
        hue={episode != null ? epHue(episode) : null}
      />
      <span style={s.epBadge(episode)}>{epLabel}</span>
      <div style={s.fileInfo}>
        <div style={s.fileName}>{fileName}</div>
        {episodeTitle && <div style={s.epTitle}>{episodeTitle}</div>}
      </div>
      <button
        style={danmakuBtnStyle(dmHover)}
        onClick={(e) => { e.stopPropagation(); onSetDanmaku(); }}
        onMouseEnter={() => setDmHover(true)}
        onMouseLeave={() => setDmHover(false)}
        aria-label="Set danmaku"
      >
        DANMAKU
      </button>
      <span style={s.playIcon(hover)}>▶ PLAY</span>
    </div>
  );
}

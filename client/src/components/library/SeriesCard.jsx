// @ts-check
import { mono, PLAYER_HUE } from '../shared/hud-tokens';
import { CornerBrackets } from '../shared/hud';

/** @typedef {import('../../lib/library/types').Series} Series */

const HUE = PLAYER_HUE.stream;

const s = {
  card: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    background: `oklch(14% 0.04 ${HUE} / 0.60)`,
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.35)`,
    borderRadius: 4,
    overflow: 'hidden',
    cursor: 'pointer',
    textAlign: 'left',
    padding: 0,
    color: '#fff',
    transition: 'border-color 150ms ease-out',
  },
  poster: {
    width: '100%',
    aspectRatio: '2/3',
    objectFit: 'cover',
    display: 'block',
  },
  monogram: {
    width: '100%',
    aspectRatio: '2/3',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: `oklch(18% 0.06 ${HUE} / 0.80)`,
    fontFamily: "'Sora', sans-serif",
    fontSize: 28,
    fontWeight: 700,
    color: `oklch(72% 0.15 ${HUE})`,
  },
  body: {
    padding: '10px 12px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  titleRow: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 6,
  },
  title: {
    fontFamily: "'Sora', sans-serif",
    fontWeight: 600,
    fontSize: 13,
    color: '#fff',
    lineHeight: 1.3,
    flex: 1,
  },
  localBadge: {
    ...mono,
    fontSize: 9,
    padding: '2px 5px',
    background: `oklch(62% 0.17 ${HUE} / 0.20)`,
    border: `1px solid oklch(62% 0.17 ${HUE} / 0.45)`,
    color: `oklch(72% 0.15 ${HUE})`,
    borderRadius: 2,
    textTransform: 'uppercase',
    letterSpacing: '0.12em',
    flexShrink: 0,
    alignSelf: 'flex-start',
    marginTop: 1,
  },
  epCount: {
    ...mono,
    fontSize: 11,
    color: `rgba(235,235,245,0.45)`,
  },
  progressTrack: {
    height: 2,
    background: `oklch(62% 0.17 ${HUE} / 0.20)`,
    borderRadius: 1,
    overflow: 'hidden',
    marginTop: 4,
  },
  progressFill: (pct) => ({
    height: '100%',
    width: `${Math.max(0, Math.min(1, pct)) * 100}%`,
    background: `oklch(62% 0.17 ${HUE})`,
    borderRadius: 1,
  }),
};

/**
 * SeriesCard — single series tile in the library grid.
 *
 * @param {{
 *   series: Series,
 *   lastPlayedEp?: number,
 *   progressPct?: number,
 *   onClick: () => void,
 * }} props
 */
export default function SeriesCard({ series, progressPct, onClick }) {
  const title = series.titleEn || series.titleZh || series.titleJa || series.id;
  const initial = title.charAt(0).toUpperCase();

  return (
    <button style={s.card} onClick={onClick} type="button" role="button">
      <CornerBrackets inset={4} size={8} opacity={0.25} hue={HUE} />

      {series.posterUrl ? (
        <img src={series.posterUrl} alt={title} style={s.poster} />
      ) : (
        <div style={s.monogram} data-testid="monogram" aria-hidden>
          {initial}
        </div>
      )}

      <div style={s.body}>
        <div style={s.titleRow}>
          <span style={s.title}>{title}</span>
          <span style={s.localBadge} data-testid="local-badge">LOCAL</span>
        </div>
        {series.totalEpisodes != null && (
          <span style={s.epCount}>{series.totalEpisodes}</span>
        )}
        {progressPct != null && (
          <div style={s.progressTrack} data-testid="progress-bar">
            <div style={s.progressFill(progressPct)} />
          </div>
        )}
      </div>
    </button>
  );
}

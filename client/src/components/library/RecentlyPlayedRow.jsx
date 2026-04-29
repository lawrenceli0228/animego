// @ts-check
import { mono, PLAYER_HUE } from '../shared/hud-tokens';

/** @typedef {import('../../lib/library/types').Series} Series */

const HUE = PLAYER_HUE.stream;

const s = {
  row: {
    display: 'flex',
    gap: 12,
    overflowX: 'auto',
    paddingBottom: 4,
  },
  card: {
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: '10px 14px',
    background: `oklch(14% 0.04 ${HUE} / 0.55)`,
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.35)`,
    borderRadius: 4,
    cursor: 'pointer',
    color: '#fff',
    textAlign: 'left',
    minWidth: 140,
    maxWidth: 200,
  },
  title: {
    fontFamily: "'Sora', sans-serif",
    fontWeight: 600,
    fontSize: 12,
    color: '#fff',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  meta: {
    ...mono,
    fontSize: 10,
    color: `rgba(235,235,245,0.45)`,
  },
};

/**
 * RecentlyPlayedRow — horizontal scroll row of recently-played entries.
 * Renders nothing when entries is empty.
 *
 * @param {{
 *   entries: { series: Series, episodeNumber: number, lastTimeSec: number }[],
 *   onPlay: (seriesId: string, episodeNumber: number) => void,
 * }} props
 */
export default function RecentlyPlayedRow({ entries, onPlay }) {
  if (!entries || entries.length === 0) return null;

  return (
    <div style={s.row}>
      {entries.map(({ series, episodeNumber, lastTimeSec }) => {
        const title = series.titleEn || series.titleZh || series.titleJa || series.id;
        return (
          <button
            key={`${series.id}-${episodeNumber}`}
            style={s.card}
            onClick={() => onPlay(series.id, episodeNumber)}
            type="button"
          >
            <span style={s.title}>{title}</span>
            <span style={s.meta}>
              EP {episodeNumber} · {Math.floor(lastTimeSec / 60)}:{String(lastTimeSec % 60).padStart(2, '0')}
            </span>
          </button>
        );
      })}
    </div>
  );
}

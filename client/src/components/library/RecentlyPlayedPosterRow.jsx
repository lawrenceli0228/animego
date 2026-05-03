// @ts-check
import SeriesCard from './SeriesCard';
import ScrollRow from './ScrollRow';

/** @typedef {import('../../lib/library/types').Series} Series */
/** @typedef {'ok'|'partial'|'offline'|'unknown'} SeriesAvailability */

/**
 * Format ms → "M:SS". Re-uses the same shape RecentlyPlayedRow exposed.
 * @param {number} sec
 */
function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = String(sec % 60).padStart(2, '0');
  return `${m}:${s}`;
}

/**
 * RecentlyPlayedPosterRow — replaces the legacy text-chip RecentlyPlayedRow
 * with a horizontal scroll row of compact poster cards. Each tile shows the
 * series poster + LOCAL badge + episode/time overlay; click resumes the
 * matching episode.
 *
 * §5.x library rows: gated upstream behind the `series.length >= 5` threshold
 * so 1-3 item libraries don't show a sparse row above their grid.
 *
 * Offline series are dropped (entire drive unplugged → no resume possible).
 * Partial-availability series are kept — the user might still have access to
 * the episode they were watching.
 *
 * @param {{
 *   entries: { series: Series, episodeNumber: number, lastTimeSec: number }[],
 *   onPlay: (seriesId: string, episodeNumber: number) => void,
 *   availabilityBySeries?: Map<string, SeriesAvailability>,
 * }} props
 */
export default function RecentlyPlayedPosterRow({
  entries,
  onPlay,
  availabilityBySeries,
}) {
  const visible = (entries || []).filter((e) => {
    const av = availabilityBySeries?.get(e.series.id);
    return av !== 'offline';
  });
  if (visible.length === 0) return null;

  return (
    <ScrollRow
      label="// 继续看 //"
      count={visible.length}
      testId="row-recently-played"
    >
      {visible.map(({ series, episodeNumber, lastTimeSec }) => (
        <SeriesCard
          key={`${series.id}-${episodeNumber}`}
          series={series}
          compact
          progressLabel={`EP ${episodeNumber} · ${formatTime(lastTimeSec)}`}
          onClick={() => onPlay(series.id, episodeNumber)}
          availability={availabilityBySeries?.get(series.id)}
        />
      ))}
    </ScrollRow>
  );
}

// @ts-check
import SeriesCard from './SeriesCard';

/** @typedef {import('../../lib/library/types').Series} Series */
/** @typedef {import('../../lib/library/types').UserOverride} UserOverride */
/** @typedef {import('../../hooks/useSeriesProgressMap').SeriesProgressInfo} SeriesProgressInfo */
/** @typedef {'lock'|'unlock'|'clear'|'merge'|'split'} OverrideAction */

const gridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
  gap: 16,
};

/**
 * Compute progressPct from completed-episode count over a series' total.
 * Returns undefined when no progress info is available, when totalEpisodes is
 * unknown, or when nothing has been watched yet — those cards skip the bar.
 *
 * @param {Series} series
 * @param {SeriesProgressInfo | undefined} info
 * @returns {number | undefined}
 */
function computePct(series, info) {
  if (!info) return undefined;
  if (typeof series.totalEpisodes !== 'number' || series.totalEpisodes <= 0) {
    return undefined;
  }
  if (info.completedCount <= 0) return undefined;
  return Math.min(1, info.completedCount / series.totalEpisodes);
}

/**
 * SeriesGrid — responsive grid of SeriesCard tiles.
 *
 * Selection (§5.6): when `selectionMode` is true the cards toggle selection
 * instead of navigating. The grid passes per-card `selected` derived from
 * `selectedIds.has(s.id)` and forwards long-press / toggle callbacks.
 *
 * @param {{
 *   series: Series[],
 *   onPickSeries: (id: string) => void,
 *   overrides?: Map<string, UserOverride>,
 *   progressMap?: Map<string, SeriesProgressInfo>,
 *   onOverrideAction?: (seriesId: string, action: OverrideAction) => void,
 *   selectionMode?: boolean,
 *   selectedIds?: Set<string>,
 *   onToggleSelect?: (seriesId: string, e?: import('react').MouseEvent) => void,
 *   onLongPress?: (seriesId: string) => void,
 * }} props
 */
export default function SeriesGrid({
  series,
  onPickSeries,
  overrides,
  progressMap,
  onOverrideAction,
  selectionMode = false,
  selectedIds,
  onToggleSelect,
  onLongPress,
}) {
  return (
    <div style={gridStyle} data-testid="series-grid">
      {series.map((s) => {
        const pct = computePct(s, progressMap?.get(s.id));
        return (
          <SeriesCard
            key={s.id}
            series={s}
            onClick={() => onPickSeries(s.id)}
            override={overrides?.get(s.id)}
            progressPct={pct}
            onOverrideAction={
              onOverrideAction
                ? (action) => onOverrideAction(s.id, action)
                : undefined
            }
            selectionMode={selectionMode}
            selected={selectedIds ? selectedIds.has(s.id) : false}
            onToggleSelect={
              onToggleSelect ? (e) => onToggleSelect(s.id, e) : undefined
            }
            onLongPress={onLongPress ? () => onLongPress(s.id) : undefined}
          />
        );
      })}
    </div>
  );
}

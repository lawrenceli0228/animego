// @ts-check
import SeriesCard from './SeriesCard';

/** @typedef {import('../../lib/library/types').Series} Series */
/** @typedef {import('../../lib/library/types').UserOverride} UserOverride */
/** @typedef {'lock'|'unlock'|'clear'|'merge'|'split'} OverrideAction */

const gridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
  gap: 16,
};

/**
 * SeriesGrid — responsive grid of SeriesCard tiles.
 *
 * @param {{
 *   series: Series[],
 *   onPickSeries: (id: string) => void,
 *   overrides?: Map<string, UserOverride>,
 *   onOverrideAction?: (seriesId: string, action: OverrideAction) => void,
 * }} props
 */
export default function SeriesGrid({
  series,
  onPickSeries,
  overrides,
  onOverrideAction,
}) {
  return (
    <div style={gridStyle} data-testid="series-grid">
      {series.map((s) => (
        <SeriesCard
          key={s.id}
          series={s}
          onClick={() => onPickSeries(s.id)}
          override={overrides?.get(s.id)}
          onOverrideAction={
            onOverrideAction
              ? (action) => onOverrideAction(s.id, action)
              : undefined
          }
        />
      ))}
    </div>
  );
}

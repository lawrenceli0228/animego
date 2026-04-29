// @ts-check
import SeriesCard from './SeriesCard';

/** @typedef {import('../../lib/library/types').Series} Series */

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
 * }} props
 */
export default function SeriesGrid({ series, onPickSeries }) {
  return (
    <div style={gridStyle} data-testid="series-grid">
      {series.map((s) => (
        <SeriesCard
          key={s.id}
          series={s}
          onClick={() => onPickSeries(s.id)}
        />
      ))}
    </div>
  );
}

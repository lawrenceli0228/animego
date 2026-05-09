// @ts-check
import { useMemo } from 'react';
import SeriesCard from './SeriesCard';
import ScrollRow from './ScrollRow';
import { useLang } from '../../context/LanguageContext';

/** @typedef {import('../../lib/library/types').Series} Series */
/** @typedef {'ok'|'partial'|'offline'|'unknown'} SeriesAvailability */

const MAX_ITEMS = 12;

/**
 * NewAdditionsRow — newest N series by `updatedAt`, rendered as a horizontal
 * scroll row of compact poster cards. Sits below RecentlyPlayed in the §5.x
 * library layout.
 *
 * Sort key is `updatedAt`, NOT `createdAt`: when the user adds new episodes
 * to an existing series, importPipeline upserts the same Series id with a
 * fresh `updatedAt` while preserving the original `createdAt`. Sorting by
 * `createdAt` would hide that update from the row entirely. `updatedAt`
 * matches user intent — "I just uploaded files, show them here" — across
 * both new-series and added-episode cases.
 *
 * Source data is the full series array; this component slices to the newest
 * MAX_ITEMS and drops anything currently unavailable (offline/partial), since
 * a "Recently added but you can't play it" tile is mostly noise.
 *
 * @param {{
 *   series: Series[],
 *   onPickSeries: (id: string) => void,
 *   availabilityBySeries?: Map<string, SeriesAvailability>,
 * }} props
 */
export default function NewAdditionsRow({
  series,
  onPickSeries,
  availabilityBySeries,
}) {
  const { t } = useLang();
  const newest = useMemo(() => {
    const accessible = (series || []).filter((sr) => {
      const av = availabilityBySeries?.get(sr.id);
      return av !== 'offline' && av !== 'partial';
    });
    return [...accessible]
      .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
      .slice(0, MAX_ITEMS);
  }, [series, availabilityBySeries]);

  if (newest.length === 0) return null;

  return (
    <ScrollRow
      label={t('library.row.newAdditions')}
      count={newest.length}
      testId="row-new-additions"
    >
      {newest.map((sr) => (
        <SeriesCard
          key={sr.id}
          series={sr}
          compact
          onClick={() => onPickSeries(sr.id)}
          availability={availabilityBySeries?.get(sr.id)}
        />
      ))}
    </ScrollRow>
  );
}

// @ts-check
import { motion, useReducedMotion } from 'motion/react';
import SeriesCard from './SeriesCard';

/** @typedef {import('../../lib/library/types').Series} Series */
/** @typedef {import('../../lib/library/types').UserOverride} UserOverride */
/** @typedef {import('../../hooks/useSeriesProgressMap').SeriesProgressInfo} SeriesProgressInfo */
/** @typedef {'lock'|'unlock'|'clear'|'merge'|'split'} OverrideAction */

// §5.4 — 4-col target at desktop. minmax 280 lands at 4 cols inside the
// 1400-wide page wrapper (inner ≈1352 after padding); auto-fill steps down
// to 3 below ~1100 and 2 below ~720, matching the design's breakpoints.
const gridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
  gap: 24,
};

// Waterfall entrance — container drops a 35ms stagger, items rise + fade.
// delayChildren waits for the HUD header settle (≈400ms) so the page reads
// as a sequence: chrome up first, content second.
const containerVariants = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.035, delayChildren: 0.4 },
  },
};
const itemVariants = {
  hidden: { opacity: 0, y: 8 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.36, ease: [0.16, 1, 0.3, 1] },
  },
};

const NEW_WINDOW_MS = 1000 * 60 * 60 * 24 * 3; // 3 days — "刚加入" budget

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
 * Compose the progress overlay label shown next to the bar.
 *  - "${completed}/${total} ✓" once everything is watched
 *  - "${completed}/${total}" while in-progress
 *  - undefined when there's nothing meaningful to show
 *
 * @param {Series} series
 * @param {SeriesProgressInfo | undefined} info
 * @returns {string | undefined}
 */
function computeLabel(series, info) {
  if (typeof series.totalEpisodes !== 'number' || series.totalEpisodes <= 0) {
    return undefined;
  }
  const total = series.totalEpisodes;
  const done = info?.completedCount ?? 0;
  if (done <= 0) return undefined;
  return done >= total ? `${done}/${total} ✓` : `${done}/${total}`;
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
 *   availabilityBySeries?: Map<string, 'ok'|'partial'|'offline'|'unknown'>,
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
  availabilityBySeries,
}) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      style={gridStyle}
      data-testid="series-grid"
      initial={reduced ? false : 'hidden'}
      animate={reduced ? undefined : 'show'}
      variants={containerVariants}
    >
      {series.map((s) => {
        const info = progressMap?.get(s.id);
        const pct = computePct(s, info);
        const label = computeLabel(s, info);
        const isNew =
          (info?.completedCount ?? 0) === 0 &&
          typeof s.createdAt === 'number' &&
          Date.now() - s.createdAt < NEW_WINDOW_MS;
        return (
          <motion.div key={s.id} variants={itemVariants}>
            <SeriesCard
              series={s}
              onClick={() => onPickSeries(s.id)}
              override={overrides?.get(s.id)}
              progressPct={pct}
              progressLabel={label}
              isNew={isNew}
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
              availability={availabilityBySeries?.get(s.id)}
            />
          </motion.div>
        );
      })}
    </motion.div>
  );
}

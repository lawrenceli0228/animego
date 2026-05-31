"use client";

import { motion, useReducedMotion } from "motion/react";
import type { MouseEvent } from "react";
import SeriesCard from "./SeriesCard";

type Series = {
  id: string;
  titleEn?: string;
  titleZh?: string;
  titleJa?: string;
  type?: string;
  totalEpisodes?: number;
  posterUrl?: string;
  createdAt?: number;
  updatedAt?: number;
};

type UserOverride = {
  locked?: boolean;
  mergedFrom?: string[];
};

type SeriesProgressInfo = {
  watchedCount: number;
  completedCount: number;
  lastPlayedAt: number;
};

// TODO P6 verify: legacy SeriesGrid.jsx JSDoc declared OverrideAction as the
// narrower 5-member union below, but SeriesCard.jsx (which this grid forwards
// onOverrideAction to) actually emits 'rematch' and 'delete' as well. JS
// erased the variance silently; TS surfaces it. Widening the union here so
// the forwarded action type matches SeriesCard's runtime contract.
type OverrideAction =
  | "lock"
  | "unlock"
  | "clear"
  | "merge"
  | "split"
  | "rematch"
  | "delete";

type SeriesAvailability = "ok" | "partial" | "offline" | "unknown";

// §5.4 — 4-col target at desktop. minmax 280 lands at 4 cols inside the
// 1400-wide page wrapper (inner ≈1352 after padding); auto-fill steps down
// to 3 below ~1100 and 2 below ~720, matching the design's breakpoints.
const gridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
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
    transition: { duration: 0.36, ease: [0.16, 1, 0.3, 1] as [number, number, number, number] },
  },
};

const NEW_WINDOW_MS = 1000 * 60 * 60 * 24 * 3; // 3 days — "刚加入" budget

/**
 * Compute progressPct from completed-episode count over a series' total.
 * Returns undefined when no progress info is available, when totalEpisodes is
 * unknown, or when nothing has been watched yet — those cards skip the bar.
 */
function computePct(
  series: Series,
  info: SeriesProgressInfo | undefined,
): number | undefined {
  if (!info) return undefined;
  if (typeof series.totalEpisodes !== "number" || series.totalEpisodes <= 0) {
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
 */
function computeLabel(
  series: Series,
  info: SeriesProgressInfo | undefined,
): string | undefined {
  if (typeof series.totalEpisodes !== "number" || series.totalEpisodes <= 0) {
    return undefined;
  }
  const total = series.totalEpisodes;
  const done = info?.completedCount ?? 0;
  if (done <= 0) return undefined;
  return done >= total ? `${done}/${total} ✓` : `${done}/${total}`;
}

interface SeriesGridProps {
  series: Series[];
  onPickSeries: (id: string) => void;
  overrides?: Map<string, UserOverride>;
  progressMap?: Map<string, SeriesProgressInfo>;
  onOverrideAction?: (seriesId: string, action: OverrideAction) => void;
  selectionMode?: boolean;
  selectedIds?: Set<string>;
  onToggleSelect?: (seriesId: string, e?: MouseEvent) => void;
  onLongPress?: (seriesId: string) => void;
  availabilityBySeries?: Map<string, SeriesAvailability>;
}

/**
 * SeriesGrid — responsive grid of SeriesCard tiles.
 *
 * Selection (§5.6): when `selectionMode` is true the cards toggle selection
 * instead of navigating. The grid passes per-card `selected` derived from
 * `selectedIds.has(s.id)` and forwards long-press / toggle callbacks.
 */
function SeriesGrid({
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
}: SeriesGridProps) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      style={gridStyle}
      data-testid="series-grid"
      initial={reduced ? false : "hidden"}
      animate={reduced ? undefined : "show"}
      variants={containerVariants}
    >
      {series.map((sr) => {
        const info = progressMap?.get(sr.id);
        const pct = computePct(sr, info);
        const label = computeLabel(sr, info);
        const isNew =
          (info?.completedCount ?? 0) === 0 &&
          typeof sr.createdAt === "number" &&
          // TODO P6 verify: React 19 lint flags Date.now() in render as impure;
          // legacy SeriesGrid.jsx ran the same expression here and parity rules
          // require byte-identical behavior. Result is stable per re-render
          // window so the UX impact is "NEW" badge may flicker off after ~3d
          // even if the user is mid-session — acceptable per legacy.
          // eslint-disable-next-line react-hooks/purity
          Date.now() - sr.createdAt < NEW_WINDOW_MS;
        return (
          <motion.div key={sr.id} variants={itemVariants}>
            <SeriesCard
              series={sr}
              onClick={() => onPickSeries(sr.id)}
              override={overrides?.get(sr.id)}
              progressPct={pct}
              progressLabel={label}
              isNew={isNew}
              onOverrideAction={
                onOverrideAction
                  ? (action) => onOverrideAction(sr.id, action)
                  : undefined
              }
              selectionMode={selectionMode}
              selected={selectedIds ? selectedIds.has(sr.id) : false}
              onToggleSelect={
                onToggleSelect ? (e) => onToggleSelect(sr.id, e) : undefined
              }
              onLongPress={onLongPress ? () => onLongPress(sr.id) : undefined}
              availability={availabilityBySeries?.get(sr.id)}
            />
          </motion.div>
        );
      })}
    </motion.div>
  );
}

export { SeriesGrid };
export default SeriesGrid;

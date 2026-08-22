"use client";

// The episode chips at the bottom of SeriesDetailSheet, lifted out of it.
//
// Two reasons, and the second is the load-bearing one:
//
//   1. The sheet was well past this repo's file-size limit before the grid
//      grew a second lane.
//   2. The rules that decide WHICH chip a file lands in, and what number that
//      chip shows, are the ones that can make a file on disk unreachable in
//      the UI (issue #75). They now live in `_services/episodeGridModel.ts`
//      where bun:test can reach them; this file is only the rendering, and
//      holds no rule of its own.

import type { CSSProperties } from "react";
import { motion } from "motion/react";
import { mono, PLAYER_HUE, PROGRESS_FILL } from "@/components/landing/shared/hud-tokens";
import { useLang } from "@/lib/lang-client";
import type { EpisodeGridModel, GridCell, GridEpisodeRow } from "../_services/episodeGridModel";

const HUE = PLAYER_HUE.local;

/** The `Progress` fields a chip reads. See `lib/library/types.js`. */
export interface EpisodeGridProgress {
  readonly completed?: boolean;
  readonly positionSec?: number;
  readonly durationSec?: number;
}

const s = {
  section: {
    padding: "20px 32px 28px",
  } as CSSProperties,
  header: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginBottom: 16,
  } as CSSProperties,
  kicker: {
    ...mono,
    fontSize: 10,
    letterSpacing: "0.16em",
    color: "rgba(235,235,245,0.45)",
    textTransform: "uppercase",
  } as CSSProperties,
  stats: {
    ...mono,
    fontSize: 10,
    letterSpacing: "0.10em",
    color: "rgba(235,235,245,0.30)",
    textTransform: "uppercase",
  } as CSSProperties,
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(64px, 1fr))",
    gap: 8,
  } as CSSProperties,
  laneHeader: {
    display: "flex",
    alignItems: "baseline",
    gap: 10,
    flexWrap: "wrap",
    margin: "24px 0 12px",
  } as CSSProperties,
  laneTitle: {
    ...mono,
    fontSize: 10,
    letterSpacing: "0.16em",
    color: `oklch(74% 0.13 ${HUE})`,
    textTransform: "uppercase",
  } as CSSProperties,
  laneHint: {
    ...mono,
    fontSize: 10,
    letterSpacing: "0.04em",
    color: "rgba(235,235,245,0.40)",
  } as CSSProperties,
  chip: {
    ...mono,
    position: "relative",
    aspectRatio: "1.1",
    borderRadius: 4,
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.30)`,
    background: `oklch(14% 0.04 ${HUE} / 0.50)`,
    color: "rgba(235,235,245,0.65)",
    fontSize: 14,
    fontWeight: 500,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    padding: 0,
    fontFamily: "inherit",
    fontVariantNumeric: "tabular-nums",
    letterSpacing: "0.02em",
    transition:
      "transform 180ms cubic-bezier(0.16,1,0.3,1), border-color 180ms ease-out, color 180ms ease-out, box-shadow 180ms ease-out",
  } as CSSProperties,
  chipDisabled: {
    cursor: "not-allowed",
    opacity: 0.35,
    background: `oklch(8% 0.02 ${HUE} / 0.40)`,
  } as CSSProperties,
  chipCompleted: {
    border: "1px solid #30d158",
    color: "#30d158",
    background: "oklch(60% 0.18 145 / 0.10)",
  } as CSSProperties,
  chipInProgress: {
    border: `1px solid ${PROGRESS_FILL}`,
    color: "#fff",
  } as CSSProperties,
  chipLastWatched: {
    border: `1px solid oklch(72% 0.16 ${HUE})`,
    color: "#fff",
    boxShadow: `0 0 0 1px oklch(72% 0.16 ${HUE} / 0.85), 0 0 16px oklch(72% 0.16 ${HUE} / 0.45)`,
  } as CSSProperties,
  chipNum: {
    fontFamily: "inherit",
    fontSize: 14,
    fontWeight: 500,
  } as CSSProperties,
  chipCheck: {
    position: "absolute",
    top: 4,
    right: 4,
    fontSize: 10,
    color: "#30d158",
  } as CSSProperties,
  chipResumeRing: {
    position: "absolute",
    top: 4,
    right: 4,
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: `oklch(72% 0.16 ${HUE})`,
    boxShadow: `0 0 8px oklch(72% 0.16 ${HUE})`,
  } as CSSProperties,
  chipProgress: {
    position: "absolute",
    left: 4,
    right: 4,
    bottom: 4,
    height: 2,
    borderRadius: 999,
    background: "rgba(255,255,255,0.15)",
    overflow: "hidden",
  } as CSSProperties,
  chipProgressFill: (pct: number): CSSProperties => ({
    height: "100%",
    width: `${Math.max(0, Math.min(1, pct)) * 100}%`,
    background: PROGRESS_FILL,
  }),
  empty: {
    ...mono,
    padding: "48px 16px",
    textAlign: "center",
    color: "rgba(235,235,245,0.45)",
    fontSize: 11,
    letterSpacing: "0.10em",
    textTransform: "uppercase",
  } as CSSProperties,
};

export const EPISODE_CHIP_CSS = `
[data-episode-chip="true"]:hover:not([disabled]) {
  transform: translateY(-2px) scale(1.04);
  border-color: oklch(72% 0.16 210 / 0.85);
  color: #fff;
  box-shadow: 0 6px 16px oklch(2% 0 0 / 0.45), 0 0 0 1px oklch(72% 0.16 210 / 0.40);
}
[data-episode-chip="true"]:focus-visible {
  outline: 2px solid oklch(72% 0.16 210 / 0.85);
  outline-offset: 2px;
}
@media (prefers-reduced-motion: reduce) {
  [data-episode-chip="true"] { transition: border-color 180ms ease-out, color 180ms ease-out; }
  [data-episode-chip="true"]:hover:not([disabled]) { transform: none !important; box-shadow: none !important; }
}
`;

export interface EpisodeGridProps {
  model: EpisodeGridModel;
  /** Keyed by `Episode.id`, as `loadMergedSeriesRows` returns it. */
  progressByEpisodeId: ReadonlyMap<string, EpisodeGridProgress>;
  /** The episode the resume CTA points at. Compared by id, never by number. */
  resumeEpisodeId?: string | null;
  /** False while the IDB read is still in flight. */
  loaded: boolean;
  reduced: boolean;
  onPick: (episode: GridEpisodeRow) => void;
}

/**
 * The episode section: the season skeleton, then anything that did not fit it.
 *
 * Both lanes render. `model.unclassified` is the only thing standing between a
 * file numbered outside its season and a UI it cannot be reached from — see
 * the R1 note on `EpisodeGridModel`.
 */
export function EpisodeGrid({
  model,
  progressByEpisodeId,
  resumeEpisodeId,
  loaded,
  reduced,
  onPick,
}: EpisodeGridProps) {
  const { t } = useLang();
  const { cells, unclassified, gridLength, inferred, episodeCount } = model;

  function renderChip(cell: GridCell, testId: string) {
    const { episode } = cell;
    const prog = episode ? progressByEpisodeId.get(episode.id) : undefined;
    const completed = prog?.completed === true;
    const inProgress = !!prog && !completed && (prog.positionSec || 0) > 0;
    const isResume = !!episode && !!resumeEpisodeId && episode.id === resumeEpisodeId && !completed;
    const pct =
      inProgress && prog?.durationSec
        ? (prog.positionSec || 0) / Math.max(1, prog.durationSec)
        : 0;
    const label = cell.number == null ? "··" : String(cell.number).padStart(2, "0");
    // A row with no usable number cannot be opened: the hand-off to /player is
    // `?resumeEpisode=<number>`, and there is nothing to put in it. It still
    // renders — losing it is the failure this lane exists to prevent — but it
    // says so rather than swallowing the click.
    const openable = episode != null && cell.number != null;
    const title =
      episode == null
        ? t("library.detail.notDownloaded").replace("{{num}}", label)
        : openable
          ? `EP ${label}`
          : t("library.detail.unclassified");

    return (
      <motion.button
        key={cell.key}
        type="button"
        data-episode-chip="true"
        data-episode-number={cell.number ?? undefined}
        data-testid={testId}
        data-state={
          completed
            ? "completed"
            : inProgress
              ? "in-progress"
              : episode
                ? "unseen"
                : "missing"
        }
        style={{
          ...s.chip,
          ...(completed ? s.chipCompleted : null),
          ...(inProgress ? s.chipInProgress : null),
          ...(isResume ? s.chipLastWatched : null),
          ...(openable ? null : s.chipDisabled),
        }}
        disabled={!openable}
        onClick={() => openable && episode && onPick(episode)}
        variants={{
          hidden: { opacity: 0, y: 6 },
          show: {
            opacity: openable ? 1 : 0.45,
            y: 0,
            transition: { duration: 0.22, ease: [0.16, 1, 0.3, 1] },
          },
        }}
        title={title}
        aria-label={title}
      >
        <span style={s.chipNum}>{label}</span>
        {completed && (
          <span style={s.chipCheck} aria-hidden>
            ✓
          </span>
        )}
        {isResume && !completed && <span style={s.chipResumeRing} aria-hidden />}
        {inProgress && (
          <div style={s.chipProgress}>
            <div style={s.chipProgressFill(pct)} />
          </div>
        )}
      </motion.button>
    );
  }

  const gridMotion = {
    initial: reduced ? false : ("hidden" as const),
    animate: reduced ? undefined : ("show" as const),
    variants: { hidden: {}, show: { transition: { staggerChildren: 0.02 } } },
  };

  return (
    <div style={s.section}>
      <div style={s.header}>
        <span style={s.kicker}>{"// EPISODES //"}</span>
        {loaded && gridLength > 0 && (
          <span style={s.stats}>
            {inferred
              ? t("library.detail.inferredTotal")
              : t("library.detail.indexedStats")
                  .replace("{{indexed}}", String(episodeCount))
                  .replace("{{total}}", String(gridLength))}
          </span>
        )}
      </div>

      {!loaded ? (
        <div style={s.empty}>{"// LOADING //"}</div>
      ) : episodeCount === 0 && gridLength <= 1 ? (
        <div style={s.empty}>{"// NO EPISODES //"}</div>
      ) : (
        <>
          <motion.div style={s.grid} {...gridMotion}>
            {cells.map((cell) => renderChip(cell, `episode-chip-${cell.number}`))}
          </motion.div>

          {unclassified.length > 0 && (
            <>
              <div style={s.laneHeader}>
                <span style={s.laneTitle}>{t("library.detail.unclassified")}</span>
                <span style={s.laneHint}>{t("library.detail.unclassifiedHint")}</span>
              </div>
              <motion.div
                style={s.grid}
                data-testid="episode-grid-unclassified"
                {...gridMotion}
              >
                {/* Keyed by episode id, not number: two lane entries can share
                    a number (two merged members that each ran 1-12). */}
                {unclassified.map((cell) =>
                  renderChip(cell, `episode-chip-extra-${cell.episode?.id ?? cell.key}`),
                )}
              </motion.div>
            </>
          )}
        </>
      )}
    </div>
  );
}

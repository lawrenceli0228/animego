// Auto "mark as watched" rule, ported from Animeko's MarkAsWatchedExtension
// (`app/shared/app-data/.../domain/player/extension/MarkAsWatchedExtension.kt`).
//
// The one non-obvious piece is the `Math.min` of two thresholds:
//
//   | duration       | 0.9 x d | d - 100s | min     | effective rule    |
//   |----------------|---------|----------|---------|-------------------|
//   | 24 min (1440s) | 1296s   | 1340s    | 1296s   | 90%               |
//   | 20 min (1200s) | 1080s   | 1100s    | 1080s   | 90%               |
//   | 3 min (180s)   | 162s    | 80s      | 80s     | 100s from the end |
//
// Long episodes fall back on the percentage; short ones on "100 seconds from
// the end", because the ending theme eats a much larger share of a short clip.
// The crossover sits at 1000s — below that, the tail margin always wins.
//
// Known trade-off (design doc decision 9, §11.2): this reads position only, so
// dragging the scrubber to the tail marks the episode watched without having
// watched it. That is accepted deliberately — a local library is browsed by
// seeking around to confirm a file is the right one, so it *will* happen. Taiga
// avoids it by counting elapsed playback seconds instead, which we do not have.
// The test suite pins this behaviour on purpose; do not "fix" it.
//
// Deliberately pure: no DOM, no Dexie, no React. `src/testImportHygiene.test.ts`
// depends on that staying true.

/** Clips shorter than this are never auto-marked (Animeko's guard). */
export const MIN_DURATION_SEC = 10;

/** Short-clip threshold: "this many seconds from the end". */
export const TAIL_MARGIN_SEC = 100;

/** Long-episode threshold, as a fraction of total duration. */
export const COMPLETION_RATIO = 0.9;

export interface ShouldMarkWatchedInput {
  /** Current playhead, in seconds. */
  readonly positionSec: number;
  /** Total media duration, in seconds. May be 0 on a legacy dirty row. */
  readonly durationSec: number;
  /** Whether the player is actually playing right now (not paused/seeking idle). */
  readonly isPlaying: boolean;
  /** Whether this episode has already been marked completed. */
  readonly alreadyMarked: boolean;
  /** User setting; defaults to on, but the caller must pass it explicitly. */
  readonly autoMarkDone: boolean;
}

/**
 * Decide whether the current playback state should flip an episode to
 * `completed`. Pure and side-effect free — the caller owns the write.
 */
export function shouldMarkWatched({
  positionSec,
  durationSec,
  isPlaying,
  alreadyMarked,
  autoMarkDone,
}: ShouldMarkWatchedInput): boolean {
  if (!autoMarkDone) return false;
  if (!isPlaying) return false;

  // Duration must be a finite positive number. Three real sources of garbage
  // arrive here: HTMLMediaElement.duration is NaN before metadata loads and
  // Infinity for live streams, and the legacy migration left durationSec=0
  // dirty rows behind (decision 12). `!(x > 0)` alone rejects NaN, zero and
  // negatives; the isFinite half is what states the Infinity case out loud.
  if (!(durationSec > 0) || !Number.isFinite(durationSec)) return false;
  if (durationSec < MIN_DURATION_SEC) return false;

  if (alreadyMarked) return false;

  // A NaN position fails `>=` on its own, but `positionSec = Infinity` would
  // satisfy it against any finite threshold. Reject both up front.
  if (!Number.isFinite(positionSec)) return false;

  return (
    positionSec >=
    Math.min(durationSec * COMPLETION_RATIO, durationSec - TAIL_MARGIN_SEC)
  );
}

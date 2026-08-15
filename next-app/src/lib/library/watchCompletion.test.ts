import { describe, expect, test } from "bun:test";
import {
  COMPLETION_RATIO,
  MIN_DURATION_SEC,
  TAIL_MARGIN_SEC,
  shouldMarkWatched,
  type ShouldMarkWatchedInput,
} from "./watchCompletion";

// A 24-minute episode: the canonical case, and the one where the 90% branch of
// the Math.min wins. Every test overrides only the field it is about.
const EPISODE_SEC = 24 * 60; // 1440
const NINETY_PERCENT = EPISODE_SEC * COMPLETION_RATIO; // 1296

function input(over: Partial<ShouldMarkWatchedInput> = {}): ShouldMarkWatchedInput {
  return {
    positionSec: NINETY_PERCENT,
    durationSec: EPISODE_SEC,
    isPlaying: true,
    alreadyMarked: false,
    autoMarkDone: true,
    ...over,
  };
}

describe("shouldMarkWatched — guards", () => {
  test("does not mark when the user turned auto-marking off", () => {
    // Arrange: a state that would otherwise mark, with the setting off.
    const state = input({ autoMarkDone: false });

    // Act
    const marked = shouldMarkWatched(state);

    // Assert
    expect(marked).toBe(false);
  });

  test("does not mark while playback is paused", () => {
    const state = input({ isPlaying: false });

    const marked = shouldMarkWatched(state);

    expect(marked).toBe(false);
  });

  test("does not mark clips shorter than the 10 second floor", () => {
    // Arrange: a 9 second clip watched to the very end.
    const state = input({ durationSec: MIN_DURATION_SEC - 1, positionSec: 9 });

    const marked = shouldMarkWatched(state);

    expect(marked).toBe(false);
  });

  test("does not mark a durationSec=0 dirty row left by the legacy migration", () => {
    // Arrange: rows migrated from the old store kept positionSec but lost
    // duration. Without this guard the threshold collapses to -100 and every
    // such row marks itself watched on the first timeupdate.
    const state = input({ durationSec: 0, positionSec: 500 });

    const marked = shouldMarkWatched(state);

    expect(marked).toBe(false);
  });

  test("does not mark when the episode is already marked", () => {
    const state = input({ alreadyMarked: true, positionSec: EPISODE_SEC });

    const marked = shouldMarkWatched(state);

    expect(marked).toBe(false);
  });

  test("does not mark when position and duration are below every threshold", () => {
    // Arrange: 80% through a 24 minute episode.
    const state = input({ positionSec: EPISODE_SEC * 0.8 });

    const marked = shouldMarkWatched(state);

    expect(marked).toBe(false);
  });
});

describe("shouldMarkWatched — thresholds", () => {
  test("marks when the playhead reaches 90% of a full-length episode", () => {
    const state = input({ positionSec: NINETY_PERCENT });

    const marked = shouldMarkWatched(state);

    expect(marked).toBe(true);
  });

  test("does not mark one second before the 90% point", () => {
    const state = input({ positionSec: NINETY_PERCENT - 1 });

    const marked = shouldMarkWatched(state);

    expect(marked).toBe(false);
  });

  test("marks a short clip at 100 seconds from the end, well before 90%", () => {
    // Arrange: a 3 minute clip. 0.9 x 180 = 162s, but 180 - 100 = 80s wins,
    // because the ending theme is a much larger share of a short clip.
    const state = input({ durationSec: 180, positionSec: 80 });

    const marked = shouldMarkWatched(state);

    expect(marked).toBe(true);
    expect(80).toBeLessThan(180 * COMPLETION_RATIO);
  });

  test("does not mark a short clip one second before its tail margin", () => {
    const state = input({ durationSec: 180, positionSec: 79 });

    const marked = shouldMarkWatched(state);

    expect(marked).toBe(false);
  });

  // The verification table from design doc §5.1. Locks which branch of the
  // Math.min wins at each duration, not merely that some threshold fired.
  const TABLE = [
    { label: "24 min", durationSec: 1440, triggersAt: 1296, branch: "ratio" },
    { label: "20 min", durationSec: 1200, triggersAt: 1080, branch: "ratio" },
    { label: "3 min", durationSec: 180, triggersAt: 80, branch: "tail" },
  ] as const;

  for (const row of TABLE) {
    test(`${row.label} episode triggers at ${row.triggersAt}s via the ${row.branch} branch`, () => {
      // Arrange / Act
      const atThreshold = shouldMarkWatched(
        input({ durationSec: row.durationSec, positionSec: row.triggersAt }),
      );
      const belowThreshold = shouldMarkWatched(
        input({ durationSec: row.durationSec, positionSec: row.triggersAt - 0.001 }),
      );

      // Assert: the exact crossover, plus which of the two thresholds produced it.
      expect(atThreshold).toBe(true);
      expect(belowThreshold).toBe(false);
      const winningThreshold =
        row.branch === "ratio"
          ? row.durationSec * COMPLETION_RATIO
          : row.durationSec - TAIL_MARGIN_SEC;
      expect(winningThreshold).toBe(row.triggersAt);
    });
  }
});

describe("shouldMarkWatched — non-finite input", () => {
  test("does not mark when durationSec is NaN", () => {
    const state = input({ durationSec: Number.NaN });

    const marked = shouldMarkWatched(state);

    expect(marked).toBe(false);
  });

  test("does not mark when durationSec is Infinity, as live/streaming media reports", () => {
    // Arrange: HTMLMediaElement.duration is Infinity until metadata resolves.
    const state = input({ durationSec: Number.POSITIVE_INFINITY, positionSec: 30 });

    const marked = shouldMarkWatched(state);

    expect(marked).toBe(false);
  });

  test("does not mark when positionSec is NaN", () => {
    const state = input({ positionSec: Number.NaN });

    const marked = shouldMarkWatched(state);

    expect(marked).toBe(false);
  });

  test("does not mark when positionSec is Infinity against a finite duration", () => {
    // Without the explicit finite guard this one returns true: Infinity
    // satisfies `>=` against any real threshold.
    const state = input({ positionSec: Number.POSITIVE_INFINITY });

    const marked = shouldMarkWatched(state);

    expect(marked).toBe(false);
  });
});

describe("shouldMarkWatched — accepted trade-offs", () => {
  test("marks watched when the user seeks to the tail without watching (accepted trade-off, decision 9)", () => {
    // THIS IS INTENTIONAL, NOT A BUG. Design doc decision 9 and §11.2: the rule
    // reads position only, so dragging the scrubber to the end marks the
    // episode watched. Browsing a local library means seeking around to confirm
    // a file is the right one, so this will really happen to real users, and we
    // accepted it rather than tracking cumulative playback seconds the way
    // Taiga does. If you are here because you decided this is a bug, change the
    // design decision first — do not delete this test.
    const seekedToTail = input({ positionSec: EPISODE_SEC - 1 });

    const marked = shouldMarkWatched(seekedToTail);

    expect(marked).toBe(true);
  });
});

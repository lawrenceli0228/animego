import { describe, expect, test } from "bun:test";

import {
  decideProgressWrite,
  isFlushReason,
  nextCompletedFlag,
  MIN_POSITION_SEC,
  POSITION_WRITE_INTERVAL_MS,
  type WatchTick,
  type WatchTickReason,
} from "./watchProgressPolicy";

const EPISODE_SEC = 1440; // 24 minutes — threshold lands at 1296s (90%)

function tick(over: Partial<WatchTick> = {}): WatchTick {
  return {
    positionSec: 600,
    durationSec: EPISODE_SEC,
    isPlaying: true,
    reason: "timeupdate",
    ...over,
  };
}

function decide(over: {
  tick?: Partial<WatchTick>;
  now?: number;
  lastWriteAt?: number | null;
  alreadyMarked?: boolean;
  autoMarkDone?: boolean;
} = {}) {
  return decideProgressWrite({
    tick: tick(over.tick),
    now: over.now ?? 1_000_000,
    lastWriteAt: over.lastWriteAt ?? null,
    alreadyMarked: over.alreadyMarked ?? false,
    autoMarkDone: over.autoMarkDone ?? true,
  });
}

describe("decideProgressWrite — duration guard (decision 17)", () => {
  // progressRepo.js:22 THROWS on these, and the throw happens inside an
  // ArtPlayer event callback where nothing catches it.
  const rejected: { label: string; durationSec: number }[] = [
    { label: "NaN before loadedmetadata", durationSec: Number.NaN },
    { label: "Infinity on a live stream", durationSec: Number.POSITIVE_INFINITY },
    { label: "zero on a legacy migrated row", durationSec: 0 },
    { label: "negative from a corrupt container", durationSec: -1 },
  ];

  for (const { label, durationSec } of rejected) {
    test(`writes nothing when duration is ${label}`, () => {
      // Arrange — a position that would otherwise be well past the threshold.
      const input = { tick: { durationSec, positionSec: 9_999 } };

      // Act
      const decision = decide(input);

      // Assert
      expect(decision).toEqual({
        write: false,
        markCompleted: false,
        reason: "no-duration",
      });
    });
  }

  test("writes nothing when the position is not a usable number", () => {
    const decision = decide({ tick: { positionSec: Number.NaN } });
    expect(decision.write).toBe(false);
    expect(decision.reason).toBe("no-position");
  });

  test("refuses a negative position even though a short clip's threshold is negative", () => {
    // A 12s clip's completion threshold is min(10.8, -88) = -88, so -5 would
    // satisfy `positionSec >= threshold` if the guard were not there first.
    const decision = decide({
      tick: { durationSec: 12, positionSec: -5, isPlaying: true },
    });
    expect(decision).toEqual({
      write: false,
      markCompleted: false,
      reason: "no-position",
    });
  });
});

describe("decideProgressWrite — 30s throttle (decision 16 / §11.3)", () => {
  test("writes the first position it sees", () => {
    const decision = decide({ lastWriteAt: null });
    expect(decision).toEqual({ write: true, markCompleted: false, reason: "position" });
  });

  test("skips a timeupdate that lands inside the throttle window", () => {
    const now = 1_000_000;
    const decision = decide({ now, lastWriteAt: now - (POSITION_WRITE_INTERVAL_MS - 1) });
    expect(decision).toEqual({ write: false, markCompleted: false, reason: "throttled" });
  });

  test("writes a timeupdate exactly at the throttle boundary", () => {
    const now = 1_000_000;
    const decision = decide({ now, lastWriteAt: now - POSITION_WRITE_INTERVAL_MS });
    expect(decision.write).toBe(true);
    expect(decision.reason).toBe("position");
  });

  test("throttles at 30 seconds, not the localStorage path's 5", () => {
    // Pins the number the whole double-tab argument rests on: two liveQuery
    // full-table subscribers re-run on every write.
    expect(POSITION_WRITE_INTERVAL_MS).toBe(30_000);
  });

  test("ignores positions below the resume floor", () => {
    const decision = decide({ tick: { positionSec: MIN_POSITION_SEC - 0.1 } });
    expect(decision).toEqual({ write: false, markCompleted: false, reason: "no-position" });
  });
});

describe("decideProgressWrite — flush points bypass the throttle", () => {
  const flushes: WatchTickReason[] = ["pause", "ended", "visibility", "unload", "teardown"];

  for (const reason of flushes) {
    test(`${reason} writes even one millisecond after the last write`, () => {
      // Arrange
      const now = 1_000_000;

      // Act
      const decision = decide({ now, lastWriteAt: now - 1, tick: { reason } });

      // Assert
      expect(decision).toEqual({ write: true, markCompleted: false, reason: "flush" });
    });
  }

  test("timeupdate is the only non-flush reason", () => {
    expect(isFlushReason("timeupdate")).toBe(false);
    for (const reason of flushes) expect(isFlushReason(reason)).toBe(true);
  });

  test("a flush still refuses to write without a usable duration", () => {
    const decision = decide({
      tick: { reason: "unload", durationSec: Number.NaN },
    });
    expect(decision.write).toBe(false);
  });
});

describe("decideProgressWrite — completion", () => {
  test("marks at 90% of a 24-minute episode and writes regardless of throttle", () => {
    // Arrange — one millisecond after a write, i.e. deep inside the throttle.
    const now = 1_000_000;

    // Act
    const decision = decide({
      now,
      lastWriteAt: now - 1,
      tick: { positionSec: EPISODE_SEC * 0.9 },
    });

    // Assert
    expect(decision).toEqual({ write: true, markCompleted: true, reason: "completed" });
  });

  test("does not mark at 80%", () => {
    const decision = decide({ tick: { positionSec: EPISODE_SEC * 0.8 } });
    expect(decision.markCompleted).toBe(false);
  });

  test("marks a short clip 100 seconds from the end, below the 5s position floor", () => {
    // A 110s clip completes at min(99, 10) = 10s. Nothing about that is below
    // the floor, but a 10s clip completes at min(9, -90) — position 0 — and
    // the floor must not swallow it.
    const decision = decide({
      tick: { durationSec: 10, positionSec: 0.5, isPlaying: true },
    });
    expect(decision).toEqual({ write: true, markCompleted: true, reason: "completed" });
  });

  test("does not re-mark once the latch is set", () => {
    const decision = decide({
      alreadyMarked: true,
      tick: { positionSec: EPISODE_SEC },
      lastWriteAt: 1_000_000 - 1,
      now: 1_000_000,
    });
    expect(decision).toEqual({ write: false, markCompleted: false, reason: "throttled" });
  });

  test("does not mark while paused, but still flushes the position", () => {
    const decision = decide({
      tick: { positionSec: EPISODE_SEC * 0.95, isPlaying: false, reason: "pause" },
    });
    expect(decision).toEqual({ write: true, markCompleted: false, reason: "flush" });
  });

  test("autoMarkDone off writes position but never completion", () => {
    const decision = decide({
      autoMarkDone: false,
      tick: { positionSec: EPISODE_SEC * 0.99 },
    });
    expect(decision.markCompleted).toBe(false);
    expect(decision.write).toBe(true);
  });

  test("seeking to the tail marks it watched — accepted trade-off, not a bug", () => {
    // Design doc §11.2 / decision 9. Pinned at the link level so nobody
    // "fixes" it later: the policy reads position only, exactly like Animeko.
    const decision = decide({
      tick: { positionSec: EPISODE_SEC - 1, isPlaying: true },
    });
    expect(decision.markCompleted).toBe(true);
  });
});

describe("nextCompletedFlag", () => {
  test("keeps a completed episode completed when it is re-watched from the start", () => {
    expect(nextCompletedFlag(true, false)).toBe(true);
  });

  test("flips on the first crossing", () => {
    expect(nextCompletedFlag(false, true)).toBe(true);
  });

  test("stays false while nothing has been watched", () => {
    expect(nextCompletedFlag(false, false)).toBe(false);
  });
});

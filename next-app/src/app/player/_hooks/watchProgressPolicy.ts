// When the player is allowed to touch `db.progress`, and what that write says.
//
// Split out of `useWatchProgress` because everything interesting here is a
// decision, and `bun test` has no DOM, no Dexie and no ArtPlayer. The hook that
// consumes this is pure plumbing: it owns the latch, the clock and the write.
//
// Three rules carry the weight, all from the design doc:
//
//  1. §3.1.1 / decision 17 — `progressRepo.js:22` *throws* when `durationSec`
//     is not a positive finite number, and that throw would land inside an
//     ArtPlayer event callback, i.e. an unhandled rejection with no user-facing
//     trace. Metadata that has not loaded yet (`NaN`), a live stream
//     (`Infinity`) and a corrupt container all arrive here. So the duration
//     guard comes first and refuses the write outright rather than letting the
//     repo validate it.
//
//  2. §3.1.1 / decision 16 — position writes throttle at 30 SECONDS, not the 5
//     seconds the localStorage path uses (`VideoPlayer.tsx:20`). `db.progress`
//     carries two liveQuery full-table subscribers (`useSeriesProgressMap`,
//     `useResume`), and they are live in any tab that has /library open. A
//     5-second cadence makes a second tab rescan the whole table 288 times per
//     episode. See §11.3.
//
//  3. §3.1.1 — pause / visibilitychange / beforeunload FLUSH, bypassing the
//     throttle. This is what makes 30s cost nothing in resume accuracy: the
//     moment the user stops or leaves, the real position lands. It is strictly
//     better than a fixed interval, which can be up to its full period stale.
//
// Deliberately pure: no DOM, no Dexie, no React. `src/testImportHygiene.test.ts`
// depends on that staying true.

import { shouldMarkWatched } from "@/lib/library/watchCompletion";

/** Throttle for ordinary position writes. Decision 16 / §11.3. */
export const POSITION_WRITE_INTERVAL_MS = 30_000;

/**
 * Below this the position is not worth a row.
 *
 * Matches `RESTORE_MIN_SECONDS` in VideoPlayer — the resume path already
 * refuses to seek to anything under 5s, so persisting it buys nothing and
 * would put a "continue watching" entry on the library page for a show the
 * user opened and immediately closed.
 *
 * A crossed completion threshold overrides this: a 10-second clip legitimately
 * completes at position 0 (its threshold is `min(9, -90)`), and dropping that
 * write would lose the checkmark.
 */
export const MIN_POSITION_SEC = 5;

/**
 * Why a tick fired. Everything that is not `timeupdate` is a flush point and
 * skips the throttle.
 */
export type WatchTickReason =
  | "timeupdate"
  | "pause"
  | "ended"
  | "visibility"
  | "unload"
  | "teardown";

export interface WatchTick {
  /** Playhead in seconds. */
  readonly positionSec: number;
  /** Media duration in seconds. `NaN` before metadata, `Infinity` for live. */
  readonly durationSec: number;
  /** `art.playing` at the moment the tick fired. */
  readonly isPlaying: boolean;
  readonly reason: WatchTickReason;
}

/** Why the policy answered the way it did. Logged, never rendered. */
export type ProgressWriteReason =
  | "no-duration"
  | "no-position"
  | "throttled"
  | "completed"
  | "flush"
  | "position";

export interface ProgressWriteDecision {
  /** Persist a `Progress` row now. */
  readonly write: boolean;
  /** This write flips `completed` from false to true. Implies `write`. */
  readonly markCompleted: boolean;
  readonly reason: ProgressWriteReason;
}

/** Everything except `timeupdate` is a flush point (§3.1.1). */
export function isFlushReason(reason: WatchTickReason): boolean {
  return reason !== "timeupdate";
}

export interface DecideProgressWriteInput {
  readonly tick: WatchTick;
  readonly now: number;
  /** `null` when nothing has been written for this episode yet. */
  readonly lastWriteAt: number | null;
  /**
   * The completion latch. Animeko's fourth guard is `cancelScope()` — "once
   * marked successfully, stop checking" — and this is where that lives.
   *
   * The caller MUST flip it at the moment the local write is issued, not when
   * Dexie's promise resolves: `timeupdate` fires roughly every 250ms and would
   * otherwise re-issue the same write for the whole round trip. It must flip
   * BACK if the write fails, which is the half Animeko gets wrong (§5.1: its
   * `cancelScope()` sits outside the try/catch, so one failure kills the
   * episode's auto-marking for good).
   */
  readonly alreadyMarked: boolean;
  /** Read fresh from `readAutoMarkDone()` per tick — never cached in a ref. */
  readonly autoMarkDone: boolean;
}

/**
 * Should the player write a progress row for this tick, and does that write
 * mark the episode watched?
 */
export function decideProgressWrite({
  tick,
  now,
  lastWriteAt,
  alreadyMarked,
  autoMarkDone,
}: DecideProgressWriteInput): ProgressWriteDecision {
  const { positionSec, durationSec, isPlaying, reason } = tick;

  // Rule 1 — the repo throws on these, inside an event callback.
  if (!(durationSec > 0) || !Number.isFinite(durationSec)) {
    return { write: false, markCompleted: false, reason: "no-duration" };
  }
  // `positionSec` has the same validator (non-negative + finite) one line
  // above it in progressRepo, and a negative position would additionally
  // satisfy the completion threshold on a short clip, where that threshold is
  // itself negative.
  if (!Number.isFinite(positionSec) || positionSec < 0) {
    return { write: false, markCompleted: false, reason: "no-position" };
  }

  const markCompleted = shouldMarkWatched({
    positionSec,
    durationSec,
    isPlaying,
    alreadyMarked,
    autoMarkDone,
  });
  if (markCompleted) {
    return { write: true, markCompleted: true, reason: "completed" };
  }

  if (positionSec < MIN_POSITION_SEC) {
    return { write: false, markCompleted: false, reason: "no-position" };
  }
  if (isFlushReason(reason)) {
    return { write: true, markCompleted: false, reason: "flush" };
  }
  if (lastWriteAt === null || now - lastWriteAt >= POSITION_WRITE_INTERVAL_MS) {
    return { write: true, markCompleted: false, reason: "position" };
  }
  return { write: false, markCompleted: false, reason: "throttled" };
}

/**
 * The `completed` value to persist.
 *
 * Once true it stays true. Re-watching an episode from the start must not
 * clear its checkmark — the local tick list is the only place "I have seen
 * this" is recorded, and the server's integer high-water mark cannot express
 * the retraction anyway (mihon#2202). Un-completing is an explicit user
 * action, not a side effect of pressing play.
 */
export function nextCompletedFlag(
  storedCompleted: boolean,
  markCompleted: boolean,
): boolean {
  return storedCompleted || markCompleted;
}

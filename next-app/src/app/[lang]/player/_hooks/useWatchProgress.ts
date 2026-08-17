"use client";

/**
 * Writes `db.progress` while the player runs. The producer the whole read side
 * of /library has been waiting for (design doc §2.1: every progress UI is built
 * and every one of them renders empty, because `progressRepo.put` has zero call
 * sites).
 *
 * SOURCE SPLIT (§3.2 / decision 7). This hook only runs when BOTH a Dexie
 * `seriesId` and `episodeId` are in hand, which happens on exactly one path:
 * entering the player from the library. A file dragged straight onto /player
 * has no episode row to hang progress off, so it keeps using the existing
 * localStorage key in VideoPlayer — position only, never `completed`, never
 * synced. That line is not an implementation detail, it is the product
 * definition: nothing is tracked until it is in the library.
 *
 * WHAT IS NOT HERE: any refresh plumbing back to /library. `db.progress`
 * carries two liveQuery subscribers (`useSeriesProgressMap`, `useResume`), so
 * the grid's progress bars, the completion filter and the continue-watching row
 * update themselves the moment this writes. Adding a second notification path
 * would be redundant (§11.3).
 */

import { useCallback, useEffect, useMemo, useRef } from "react";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — JS module with JSDoc types
import { makeProgressRepo } from "@/lib/library/db/progressRepo.js";
import { readAutoMarkDone } from "@/lib/playerSettings";

import {
  decideProgressWrite,
  nextCompletedFlag,
  type WatchTick,
} from "./watchProgressPolicy";

export interface WatchProgressEpisode {
  readonly seriesId: string;
  readonly episodeId: string;
}

export interface UseWatchProgressArgs {
  /** Dexie instance. Typed loosely because db.js is a JSDoc-annotated module. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly db: any;
  /** Dexie `Series.id` of the episode being played, or null off the library path. */
  readonly seriesId: string | null;
  /** Dexie `Episode.id` (a ULID), or null off the library path. */
  readonly episodeId: string | null;
  /** CG1 — a failed write MUST reach the user. Called once per episode. */
  readonly onWriteError?: (err: unknown) => void;
  /** Fired after `completed` lands in Dexie. Trigger 1 of the reconciler. */
  readonly onCompleted?: (episode: WatchProgressEpisode) => void;
}

export interface UseWatchProgressResult {
  /** Hand straight to `<VideoPlayer onWatchTick>`. Stable across renders. */
  readonly handleTick: (tick: WatchTick) => void;
}

interface EpisodeWriteState {
  /** Identity of the episode this state belongs to; guards late async writes. */
  readonly key: string;
  readonly seriesId: string;
  readonly episodeId: string;
  /**
   * The completion latch (Animeko's `cancelScope()`, §5.1).
   *
   * Also the value written to `Progress.completed`, which is why re-watching a
   * finished episode cannot clear its checkmark.
   */
  completed: boolean;
  lastWriteAt: number | null;
  writing: boolean;
  errorReported: boolean;
}

const EMPTY_STATE: EpisodeWriteState = {
  key: "",
  seriesId: "",
  episodeId: "",
  completed: false,
  lastWriteAt: null,
  writing: false,
  errorReported: false,
};

export function useWatchProgress({
  db,
  seriesId,
  episodeId,
  onWriteError,
  onCompleted,
}: UseWatchProgressArgs): UseWatchProgressResult {
  const repo = useMemo(() => makeProgressRepo(db), [db]);
  const stateRef = useRef<EpisodeWriteState>(EMPTY_STATE);

  const onWriteErrorRef = useRef(onWriteError);
  const onCompletedRef = useRef(onCompleted);
  useEffect(() => {
    onWriteErrorRef.current = onWriteError;
  }, [onWriteError]);
  useEffect(() => {
    onCompletedRef.current = onCompleted;
  }, [onCompleted]);

  // Reset on episode change, then hydrate the latch from whatever is already
  // stored. Without the hydrate, re-opening a finished episode would re-mark
  // it and re-push — harmless (the server's monotonic path folds a repeat into
  // a true no-op) but pointless traffic, and it would relight the local write.
  useEffect(() => {
    const key = `${seriesId ?? ""}:${episodeId ?? ""}`;
    stateRef.current = seriesId && episodeId
      ? { ...EMPTY_STATE, key, seriesId, episodeId }
      : EMPTY_STATE;
    if (!seriesId || !episodeId) return undefined;

    let cancelled = false;
    (async () => {
      try {
        const row = await repo.get(episodeId);
        if (cancelled) return;
        const state = stateRef.current;
        if (state.key !== key) return;
        if (row?.completed === true) state.completed = true;
      } catch (err) {
        // A failed READ costs at most one redundant mark; it is not worth a
        // toast. The failed WRITE is the one the user has to hear about.
        // eslint-disable-next-line no-console
        console.warn("[watchProgress] could not read stored progress:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repo, seriesId, episodeId]);

  const handleTick = useCallback(
    (tick: WatchTick) => {
      const state = stateRef.current;
      // No episode row → the drag-and-drop path. localStorage owns it.
      if (!state.seriesId || !state.episodeId) return;
      // A write is already in flight for this episode; `timeupdate` fires four
      // times a second and would otherwise stack duplicates on the same key.
      if (state.writing) return;

      const now = Date.now();
      const decision = decideProgressWrite({
        tick,
        now,
        lastWriteAt: state.lastWriteAt,
        alreadyMarked: state.completed,
        // Read fresh, never cached in a ref: it is a synchronous getItem, and
        // caching loses the case where the user just changed it in another tab.
        autoMarkDone: readAutoMarkDone(),
      });
      if (!decision.write) return;

      const previousCompleted = state.completed;
      const previousWriteAt = state.lastWriteAt;

      // ─── the latch flips HERE, before the await ───
      // Not when Dexie's promise resolves: `timeupdate` would re-enter the
      // whole decision several times during the round trip and re-issue the
      // same write. Animeko sets its equivalent flag outside the try/catch and
      // therefore never retries a failed mark (§5.1); the revert in the catch
      // below is what buys us the retry it does not have.
      if (decision.markCompleted) state.completed = true;
      state.lastWriteAt = now;
      state.writing = true;

      const row = {
        episodeId: state.episodeId,
        seriesId: state.seriesId,
        // progressRepo rejects a negative or non-finite position; the policy
        // has already vetted this one. Rounded to match `setLastTime`.
        positionSec: Math.max(0, Math.round(tick.positionSec)),
        // Decision 12: this is the durationSec backfill. The legacy migration
        // left rows at 0 to preserve their position, and the first real play
        // simply overwrites them with the media element's answer.
        durationSec: tick.durationSec,
        updatedAt: now,
        completed: nextCompletedFlag(previousCompleted, decision.markCompleted),
      };

      void (async () => {
        try {
          await repo.put(row);
          state.writing = false;
          if (decision.markCompleted) {
            onCompletedRef.current?.({
              seriesId: state.seriesId,
              episodeId: state.episodeId,
            });
          }
        } catch (err) {
          // CG1 — the one thing this must not do is what the localStorage path
          // does two files over (`catch { /* ignore */ }`). A full quota or a
          // Safari private window would otherwise mean the episode never ticks
          // off, never syncs, and says nothing about it.
          state.writing = false;
          // Un-latch so the next tick retries. Restoring lastWriteAt too, so
          // the retry is not also stuck behind the 30-second throttle.
          state.completed = previousCompleted;
          state.lastWriteAt = previousWriteAt;
          if (!state.errorReported) {
            state.errorReported = true;
            onWriteErrorRef.current?.(err);
          }
          // eslint-disable-next-line no-console
          console.warn("[watchProgress] progress write failed:", err);
        }
      })();
    },
    [repo],
  );

  return { handleTick };
}

export default useWatchProgress;

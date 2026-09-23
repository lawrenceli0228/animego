// Merge cycles: how two cards can hide each other, and how to undo it.
//
// useLibrary hides every id that appears in any `mergedFrom` (`mergedAwayIds`).
// That rule has no notion of a root, so if A lists B and B lists A, both are
// hidden and there is no card left on the grid to hold either one. Every
// episode under them is still indexed and still on disk, reachable from
// nowhere. From the reader's seat: "I merged them and everything disappeared".
//
// ─── how a library got into that state ──────────────────────────────────────
//
// The duplicate sweep (`dedupeSeries.ts`) always merges INTO the oldest row
// and reads every series, merged-in ones included. A reader who had merged the
// older copy into the newer one by hand (B.mergedFrom = [A]) had it reversed on
// their next visit: the sweep saw A and B share an AniList id and merged B into
// A. performMerge only asked "is B already in A's list?", never "is A already
// inside B's card?", so it wrote A.mergedFrom = [B] and closed the loop.
//
// Two halves to the fix, and both are needed:
//
//   wouldCreateMergeCycle  — performMerge refuses the write, so no caller can
//                            close a loop again.
//   findMergeCycleCuts     — libraries that already carry a loop get it
//                            broken, or the refusal alone would leave those
//                            cards hidden forever.

import { resolveMergedSeriesIds } from "./resolveMergedIds";

interface CycleOverrideLike {
  seriesId?: string;
  mergedFrom?: string[];
  updatedAt?: number;
}

/** One `mergedFrom` entry: `sourceSeriesId` is listed on `targetSeriesId`. */
export interface MergeEdge {
  targetSeriesId: string;
  sourceSeriesId: string;
}

/**
 * Would merging `sourceSeriesId` into `targetSeriesId` make the two cards
 * contain each other?
 *
 * True exactly when the target is already on the source's card — directly or
 * through a chain — which includes a self-merge. The reverse case (the source
 * is already on the target's card) is NOT a cycle, just a repeat, and
 * performMerge handles that on its own.
 */
export function wouldCreateMergeCycle(
  overrides: readonly CycleOverrideLike[] | null | undefined,
  sourceSeriesId: string,
  targetSeriesId: string,
): boolean {
  return resolveMergedSeriesIds(overrides, sourceSeriesId).includes(targetSeriesId);
}

interface CandidateCut extends MergeEdge {
  writtenAt: number;
  index: number;
}

/** Does `a` rank as the more recently written edge than `b`? */
function isLater(a: CandidateCut, b: CandidateCut): boolean {
  if (a.writtenAt !== b.writtenAt) return a.writtenAt > b.writtenAt;
  if (a.index !== b.index) return a.index > b.index;
  return a.targetSeriesId > b.targetSeriesId;
}

/**
 * The `mergedFrom` entries to remove so that no merge cycle remains, in the
 * order they should be removed.
 *
 * Each round cuts ONE edge that lies on a cycle — the most recently written
 * one — and re-evaluates, so an edge that only looked cyclic because of a loop
 * already broken is left alone. Edges off every cycle are never touched: a
 * duplicate that was legitimately merged stays merged.
 *
 * "Most recently written" is the override row's `updatedAt`, then the entry's
 * position in `mergedFrom` (performMerge only appends). In the loop the sweep
 * produced, the sweep's write is the later one, so cutting it hands the card
 * back to the row the reader chose. Once a loop exists its rows are all hidden
 * and nothing the reader does can touch them, so that ordering survives until
 * the repair runs.
 *
 * Pure. The override table is small (one row per series the reader has
 * touched), so the quadratic re-scan is not worth an SCC algorithm.
 */
export function findMergeCycleCuts(
  overrides: readonly CycleOverrideLike[] | null | undefined,
): MergeEdge[] {
  const lists = new Map<string, string[]>();
  const writtenAt = new Map<string, number>();
  for (const o of overrides ?? []) {
    if (!o || typeof o.seriesId !== "string" || !o.seriesId) continue;
    if (!Array.isArray(o.mergedFrom)) continue;
    const kids = o.mergedFrom.filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    );
    if (kids.length === 0) continue;
    lists.set(o.seriesId, kids);
    writtenAt.set(o.seriesId, typeof o.updatedAt === "number" ? o.updatedAt : 0);
  }

  const cuts: MergeEdge[] = [];
  for (;;) {
    const current = [...lists].map(([seriesId, mergedFrom]) => ({
      seriesId,
      mergedFrom,
    }));

    let latest: CandidateCut | null = null;
    for (const [targetSeriesId, kids] of lists) {
      for (let index = 0; index < kids.length; index++) {
        const sourceSeriesId = kids[index];
        if (!wouldCreateMergeCycle(current, sourceSeriesId, targetSeriesId)) continue;
        const candidate: CandidateCut = {
          targetSeriesId,
          sourceSeriesId,
          writtenAt: writtenAt.get(targetSeriesId) ?? 0,
          index,
        };
        if (!latest || isLater(candidate, latest)) latest = candidate;
      }
    }

    if (!latest) return cuts;
    const { targetSeriesId, sourceSeriesId, index } = latest;
    cuts.push({ targetSeriesId, sourceSeriesId });
    const kids = lists.get(targetSeriesId) ?? [];
    lists.set(
      targetSeriesId,
      kids.filter((_, i) => i !== index),
    );
  }
}

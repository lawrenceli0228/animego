"use client";

// Ported from client/src/services/mergeOps.js. Merge `sourceSeriesId` into
// `targetSeriesId`:
//   1. snapshot the target's current `userOverride` (so undo can restore exactly),
//   2. add `sourceSeriesId` to target.mergedFrom (de-duped), unless the
//      target is already on the source's card — that write would make the two
//      cards contain each other and the grid would hide both (mergeCycles.ts),
//   3. write an opsLog entry holding the snapshot + a UI summary.

import type Dexie from "dexie";
// The library/db helpers are JS modules — they get type-checked via JSDoc.
// We pull them as untyped objects and provide our own surface here.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — JS module with JSDoc types
import { makeUserOverrideRepo } from "@/lib/library/db/userOverrideRepo.js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — JS module with JSDoc types
import { makeOpsLogRepo } from "@/lib/library/db/opsLogRepo.js";
import {
  findMergeCycleCuts,
  wouldCreateMergeCycle,
  type MergeEdge,
} from "./mergeCycles";

export interface UserOverrideRow {
  seriesId: string;
  mergedFrom?: string[];
  splitFrom?: string;
  locked?: boolean;
  overrideSeasonAnimeId?: number;
  normalizedTokens?: string[];
  updatedAt?: number;
}

export interface OpsLogRow {
  id: string;
  seriesId: string;
  ts: number;
  kind: "merge" | "split" | "rematch" | "unfile" | "delete";
  payload: Record<string, unknown>;
  summary?: Record<string, unknown>;
  undoableUntil: number;
  undone?: boolean;
}

/** The whole override table — small, one row per series the reader touched. */
function readAllOverrides(db: Dexie): Promise<UserOverrideRow[]> {
  const tables = db as unknown as {
    userOverride: { toArray(): Promise<UserOverrideRow[]> };
  };
  return tables.userOverride.toArray();
}

interface PerformMergeArgs {
  db: Dexie;
  sourceSeriesId: string;
  targetSeriesId: string;
  summary?: Record<string, unknown>;
  now?: () => number;
  makeId?: () => string;
}

export async function performMerge(
  args: PerformMergeArgs,
): Promise<OpsLogRow | null> {
  const { db, sourceSeriesId, targetSeriesId, summary, now, makeId } = args;
  if (!db) throw new Error("performMerge: db is required");
  if (typeof sourceSeriesId !== "string" || !sourceSeriesId) {
    throw new Error("performMerge: sourceSeriesId is required");
  }
  if (typeof targetSeriesId !== "string" || !targetSeriesId) {
    throw new Error("performMerge: targetSeriesId is required");
  }
  if (sourceSeriesId === targetSeriesId) return null;

  const overrideRepo = makeUserOverrideRepo(db, now ? { now } : undefined);
  const opsRepo = makeOpsLogRepo(db, {
    ...(now ? { now } : {}),
    ...(makeId ? { makeId } : {}),
  });

  const prior = (await overrideRepo.get(targetSeriesId)) as
    | UserOverrideRow
    | null;
  const priorMergedFrom = Array.isArray(prior?.mergedFrom)
    ? prior.mergedFrom.slice()
    : [];

  if (priorMergedFrom.includes(sourceSeriesId)) {
    return null;
  }

  // The target already sits on the source's card. Writing this would make the
  // two cards contain each other, and the grid hides both — see
  // `mergeCycles.ts`. They are already one card, so there is nothing to do.
  const allOverrides = await readAllOverrides(db);
  if (wouldCreateMergeCycle(allOverrides, sourceSeriesId, targetSeriesId)) {
    return null;
  }

  const nextMergedFrom = [...priorMergedFrom, sourceSeriesId];
  await overrideRepo.update(targetSeriesId, { mergedFrom: nextMergedFrom });

  return opsRepo.append({
    seriesId: targetSeriesId,
    kind: "merge",
    payload: {
      sourceSeriesId,
      targetSeriesId,
      priorOverride: prior ?? null,
    },
    summary,
  }) as Promise<OpsLogRow>;
}

interface RepairMergeCyclesArgs {
  db: Dexie;
  now?: () => number;
}

/**
 * Break every merge cycle already written to this library, so the cards it
 * was hiding come back. Returns the `mergedFrom` entries it removed.
 *
 * performMerge refuses new cycles, but libraries that picked one up before
 * that guard existed still have both cards hidden, and nothing else would ever
 * bring them back. Which entry goes is `findMergeCycleCuts`' call.
 *
 * Soft, like the merge it undoes: only `mergedFrom` changes. No Series,
 * Season, Episode or Progress row is touched.
 */
export async function repairMergeCycles(
  args: RepairMergeCyclesArgs,
): Promise<MergeEdge[]> {
  const { db, now } = args;
  if (!db) throw new Error("repairMergeCycles: db is required");

  const cuts = findMergeCycleCuts(await readAllOverrides(db));
  if (cuts.length === 0) return cuts;

  const removeByTarget = new Map<string, Set<string>>();
  for (const { targetSeriesId, sourceSeriesId } of cuts) {
    const sources = removeByTarget.get(targetSeriesId) ?? new Set<string>();
    sources.add(sourceSeriesId);
    removeByTarget.set(targetSeriesId, sources);
  }

  const overrideRepo = makeUserOverrideRepo(db, now ? { now } : undefined);
  for (const [targetSeriesId, sources] of removeByTarget) {
    // Re-read rather than reuse the scan: filter the list as it is NOW, so a
    // merge written in between is not dropped along with the cut.
    const fresh = (await overrideRepo.get(targetSeriesId)) as UserOverrideRow | null;
    const mergedFrom = Array.isArray(fresh?.mergedFrom) ? fresh.mergedFrom : [];
    await overrideRepo.update(targetSeriesId, {
      mergedFrom: mergedFrom.filter((id) => !sources.has(id)),
    });
  }
  return cuts;
}

interface UndoMergeArgs {
  db: Dexie;
  opId: string;
  now?: () => number;
}

export async function undoMerge(
  args: UndoMergeArgs,
): Promise<{ targetSeriesId: string }> {
  const { db, opId, now } = args;
  if (!db) throw new Error("undoMerge: db is required");
  if (typeof opId !== "string" || !opId) {
    throw new Error("undoMerge: opId is required");
  }
  const overrideRepo = makeUserOverrideRepo(db, now ? { now } : undefined);
  const opsRepo = makeOpsLogRepo(db, now ? { now } : undefined);

  const op = (await opsRepo.get(opId)) as OpsLogRow | undefined;
  if (!op) throw new Error(`undoMerge: op "${opId}" not found`);
  if (op.kind !== "merge")
    throw new Error(
      `undoMerge: op "${opId}" is not a merge (kind=${op.kind})`,
    );
  if (op.undone) throw new Error(`undoMerge: op "${opId}" already undone`);

  const payload = (op.payload ?? {}) as {
    sourceSeriesId?: string;
    targetSeriesId?: string;
    priorOverride?: UserOverrideRow | null;
  };
  const { targetSeriesId, priorOverride } = payload;
  if (typeof targetSeriesId !== "string" || !targetSeriesId) {
    throw new Error(`undoMerge: payload missing targetSeriesId for op "${opId}"`);
  }

  if (priorOverride) {
    await overrideRepo.put(priorOverride);
  } else {
    await overrideRepo.delete(targetSeriesId);
  }

  await opsRepo.markUndone(opId);
  return { targetSeriesId };
}

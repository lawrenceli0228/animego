// @ts-check
import { makeUserOverrideRepo } from '../lib/library/db/userOverrideRepo.js';
import { makeOpsLogRepo } from '../lib/library/db/opsLogRepo.js';

/** @typedef {import('../lib/library/types').UserOverride} UserOverride */
/** @typedef {import('../lib/library/types').OpsLog} OpsLog */

/**
 * Merge `sourceSeriesId` into `targetSeriesId`:
 *   1. snapshot the target's current `userOverride` (so undo can restore exactly),
 *   2. add `sourceSeriesId` to target.mergedFrom (de-duped),
 *   3. write an opsLog entry holding the snapshot + a UI summary.
 *
 * Returns the new opsLog row so callers can pass `id`/`summary` straight to UndoToast.
 *
 * No-op when source === target — returns null without touching IDB.
 *
 * @param {{
 *   db: import('dexie').Dexie,
 *   sourceSeriesId: string,
 *   targetSeriesId: string,
 *   summary?: Record<string, unknown>,
 *   now?: () => number,
 *   makeId?: () => string,
 * }} args
 * @returns {Promise<OpsLog|null>}
 */
export async function performMerge({
  db,
  sourceSeriesId,
  targetSeriesId,
  summary,
  now,
  makeId,
}) {
  if (!db) throw new Error('performMerge: db is required');
  if (typeof sourceSeriesId !== 'string' || !sourceSeriesId) {
    throw new Error('performMerge: sourceSeriesId is required');
  }
  if (typeof targetSeriesId !== 'string' || !targetSeriesId) {
    throw new Error('performMerge: targetSeriesId is required');
  }
  if (sourceSeriesId === targetSeriesId) return null;

  const overrideRepo = makeUserOverrideRepo(db, now ? { now } : undefined);
  const opsRepo = makeOpsLogRepo(db, { ...(now ? { now } : {}), ...(makeId ? { makeId } : {}) });

  const prior = await overrideRepo.get(targetSeriesId);
  const priorMergedFrom = Array.isArray(prior?.mergedFrom) ? prior.mergedFrom.slice() : [];

  if (priorMergedFrom.includes(sourceSeriesId)) {
    return null;
  }

  const nextMergedFrom = [...priorMergedFrom, sourceSeriesId];
  await overrideRepo.update(targetSeriesId, { mergedFrom: nextMergedFrom });

  return opsRepo.append({
    seriesId: targetSeriesId,
    kind: 'merge',
    payload: {
      sourceSeriesId,
      targetSeriesId,
      priorOverride: prior ?? null,
    },
    summary,
  });
}

/**
 * Undo a previously-recorded merge:
 *   1. read the opsLog entry (must be a 'merge' kind, must not yet be undone),
 *   2. restore the prior userOverride snapshot (delete row if no prior, write back otherwise),
 *   3. mark the opsLog entry undone.
 *
 * Throws if the op id is missing, is not a merge, or is past `undoableUntil`.
 *
 * @param {{
 *   db: import('dexie').Dexie,
 *   opId: string,
 *   now?: () => number,
 * }} args
 * @returns {Promise<{ targetSeriesId: string }>}
 */
export async function undoMerge({ db, opId, now }) {
  if (!db) throw new Error('undoMerge: db is required');
  if (typeof opId !== 'string' || !opId) {
    throw new Error('undoMerge: opId is required');
  }
  const overrideRepo = makeUserOverrideRepo(db, now ? { now } : undefined);
  const opsRepo = makeOpsLogRepo(db, now ? { now } : undefined);

  const op = await opsRepo.get(opId);
  if (!op) throw new Error(`undoMerge: op "${opId}" not found`);
  if (op.kind !== 'merge') throw new Error(`undoMerge: op "${opId}" is not a merge (kind=${op.kind})`);
  if (op.undone) throw new Error(`undoMerge: op "${opId}" already undone`);

  const payload = /** @type {{ sourceSeriesId: string, targetSeriesId: string, priorOverride: UserOverride|null }} */ (
    op.payload ?? {}
  );
  const { targetSeriesId, priorOverride } = payload;
  if (typeof targetSeriesId !== 'string' || !targetSeriesId) {
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

// @ts-check
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../lib/library/db/db.js';
import { makeUserOverrideRepo } from '../lib/library/db/userOverrideRepo.js';
import { makeOpsLogRepo } from '../lib/library/db/opsLogRepo.js';
import { performMerge, undoMerge } from '../services/mergeOps.js';

describe('performMerge / undoMerge (§5.6)', () => {
  let db;
  let now = 1_000_000;
  const fixedNow = () => now;
  const seq = (() => { let i = 0; return () => `op-${++i}`; })();

  beforeEach(async () => {
    db = getDb('test-mergeOps-' + Date.now() + Math.random());
    await db.open();
    now = 1_000_000;
  });

  it('writes mergedFrom on target + appends opsLog with prior=null', async () => {
    const op = await performMerge({
      db,
      sourceSeriesId: 'sr-A',
      targetSeriesId: 'sr-B',
      summary: { targetTitle: 'B' },
      now: fixedNow,
      makeId: seq,
    });
    expect(op).toMatchObject({
      kind: 'merge',
      seriesId: 'sr-B',
      undone: false,
      summary: { targetTitle: 'B' },
    });
    expect(op.payload).toEqual({
      sourceSeriesId: 'sr-A',
      targetSeriesId: 'sr-B',
      priorOverride: null,
    });

    const overrideRepo = makeUserOverrideRepo(db, { now: fixedNow });
    const ov = await overrideRepo.get('sr-B');
    expect(ov?.mergedFrom).toEqual(['sr-A']);
  });

  it('appending second merge captures the prior override snapshot', async () => {
    const overrideRepo = makeUserOverrideRepo(db, { now: fixedNow });
    await overrideRepo.put({ seriesId: 'sr-B', locked: true, mergedFrom: ['sr-X'] });

    const op = await performMerge({
      db,
      sourceSeriesId: 'sr-A',
      targetSeriesId: 'sr-B',
      now: fixedNow,
      makeId: seq,
    });
    const payload = op.payload;
    expect(payload.priorOverride).toMatchObject({
      seriesId: 'sr-B',
      locked: true,
      mergedFrom: ['sr-X'],
    });

    const ov = await overrideRepo.get('sr-B');
    expect(ov?.mergedFrom).toEqual(['sr-X', 'sr-A']);
    expect(ov?.locked).toBe(true);
  });

  it('returns null for self-merge and skips IDB writes', async () => {
    const op = await performMerge({
      db,
      sourceSeriesId: 'sr-A',
      targetSeriesId: 'sr-A',
      now: fixedNow,
      makeId: seq,
    });
    expect(op).toBeNull();
    const overrideRepo = makeUserOverrideRepo(db, { now: fixedNow });
    expect(await overrideRepo.get('sr-A')).toBeNull();
  });

  it('returns null when source already in mergedFrom (idempotent)', async () => {
    await performMerge({ db, sourceSeriesId: 'sr-A', targetSeriesId: 'sr-B', now: fixedNow, makeId: seq });
    const second = await performMerge({
      db,
      sourceSeriesId: 'sr-A',
      targetSeriesId: 'sr-B',
      now: fixedNow,
      makeId: seq,
    });
    expect(second).toBeNull();

    const opsRepo = makeOpsLogRepo(db, { now: fixedNow });
    const list = await opsRepo.listForSeries('sr-B');
    expect(list).toHaveLength(1);
  });

  it('rejects bad input', async () => {
    await expect(performMerge({ db })).rejects.toThrow(/sourceSeriesId/);
    await expect(performMerge({ db, sourceSeriesId: 'sr-a' })).rejects.toThrow(/targetSeriesId/);
    await expect(performMerge({ sourceSeriesId: 'a', targetSeriesId: 'b' })).rejects.toThrow(/db/);
  });

  describe('undoMerge', () => {
    it('restores the override to prior=null state (delete row)', async () => {
      const op = await performMerge({
        db,
        sourceSeriesId: 'sr-A',
        targetSeriesId: 'sr-B',
        now: fixedNow,
        makeId: seq,
      });
      const overrideRepo = makeUserOverrideRepo(db, { now: fixedNow });
      expect((await overrideRepo.get('sr-B'))?.mergedFrom).toEqual(['sr-A']);

      const result = await undoMerge({ db, opId: op.id, now: fixedNow });
      expect(result.targetSeriesId).toBe('sr-B');
      expect(await overrideRepo.get('sr-B')).toBeNull();

      const opsRepo = makeOpsLogRepo(db, { now: fixedNow });
      const reread = await opsRepo.get(op.id);
      expect(reread?.undone).toBe(true);
    });

    it('restores the prior override exactly when one existed', async () => {
      const overrideRepo = makeUserOverrideRepo(db, { now: fixedNow });
      await overrideRepo.put({
        seriesId: 'sr-B',
        locked: true,
        mergedFrom: ['sr-X'],
        normalizedTokens: ['token1'],
      });

      const op = await performMerge({
        db,
        sourceSeriesId: 'sr-A',
        targetSeriesId: 'sr-B',
        now: fixedNow,
        makeId: seq,
      });
      await undoMerge({ db, opId: op.id, now: fixedNow });

      const restored = await overrideRepo.get('sr-B');
      expect(restored).toMatchObject({
        seriesId: 'sr-B',
        locked: true,
        mergedFrom: ['sr-X'],
        normalizedTokens: ['token1'],
      });
    });

    it('refuses to undo twice', async () => {
      const op = await performMerge({
        db,
        sourceSeriesId: 'sr-A',
        targetSeriesId: 'sr-B',
        now: fixedNow,
        makeId: seq,
      });
      await undoMerge({ db, opId: op.id, now: fixedNow });
      await expect(undoMerge({ db, opId: op.id, now: fixedNow })).rejects.toThrow(/already undone/);
    });

    it('refuses to undo unknown op ids', async () => {
      await expect(undoMerge({ db, opId: 'missing', now: fixedNow })).rejects.toThrow(/not found/);
    });

    it('refuses non-merge kinds', async () => {
      const opsRepo = makeOpsLogRepo(db, { now: fixedNow, makeId: seq });
      const split = await opsRepo.append({ seriesId: 'sr-B', kind: 'split', payload: {} });
      await expect(undoMerge({ db, opId: split.id, now: fixedNow })).rejects.toThrow(/not a merge/);
    });

    it('refuses to undo past the 24h window', async () => {
      const op = await performMerge({
        db,
        sourceSeriesId: 'sr-A',
        targetSeriesId: 'sr-B',
        now: fixedNow,
        makeId: seq,
      });
      const future = () => op.undoableUntil + 1;
      await expect(undoMerge({ db, opId: op.id, now: future })).rejects.toThrow(/expired/);
    });
  });
});

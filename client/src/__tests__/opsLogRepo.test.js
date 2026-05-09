// @ts-check
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../lib/library/db/db.js';
import { makeOpsLogRepo } from '../lib/library/db/opsLogRepo.js';

describe('opsLogRepo (§5.6 24h undo + history)', () => {
  let testDb;
  let repo;
  let clock;

  beforeEach(async () => {
    testDb = getDb('test-opsLog-' + Date.now() + Math.random());
    await testDb.open();
    clock = 1_000_000;
    repo = makeOpsLogRepo(testDb, {
      now: () => clock,
      makeId: () => `id-${clock}-${Math.random().toString(36).slice(2, 6)}`,
    });
  });

  it('append + get round trip with auto ts and 24h window', async () => {
    const row = await repo.append({
      seriesId: 'sr-1',
      kind: 'merge',
      payload: { from: 'sr-x' },
      summary: { targetTitle: 'Foo' },
    });
    expect(row.id).toBeTruthy();
    expect(row.ts).toBe(1_000_000);
    expect(row.undoableUntil).toBe(1_000_000 + 24 * 60 * 60 * 1000);
    expect(row.undone).toBe(false);
    const got = await repo.get(row.id);
    expect(got).toMatchObject({
      seriesId: 'sr-1',
      kind: 'merge',
      payload: { from: 'sr-x' },
    });
  });

  it('append rejects bad input', async () => {
    await expect(repo.append({})).rejects.toThrow(/seriesId/);
    await expect(
      repo.append({ seriesId: 'sr-1', kind: 'unknown' }),
    ).rejects.toThrow(/unknown kind/);
    await expect(
      repo.append({ seriesId: 'sr-1', kind: 'merge', payload: 7 }),
    ).rejects.toThrow(/payload/);
  });

  it('get returns null for missing id', async () => {
    expect(await repo.get('nope')).toBeNull();
  });

  it('listForSeries returns entries newest first, limited per series', async () => {
    clock = 100; await repo.append({ seriesId: 'A', kind: 'merge', payload: {} });
    clock = 200; await repo.append({ seriesId: 'B', kind: 'merge', payload: {} });
    clock = 300; const newest = await repo.append({ seriesId: 'A', kind: 'split', payload: {} });
    clock = 400; await repo.append({ seriesId: 'A', kind: 'rematch', payload: {} });
    const list = await repo.listForSeries('A');
    expect(list.map((r) => r.kind)).toEqual(['rematch', 'split', 'merge']);
    expect(list.find((r) => r.id === newest.id)).toBeDefined();
  });

  it('listForSeries respects limit', async () => {
    for (let i = 0; i < 5; i++) {
      clock = 1000 + i;
      await repo.append({ seriesId: 'X', kind: 'merge', payload: { i } });
    }
    const list = await repo.listForSeries('X', { limit: 2 });
    expect(list).toHaveLength(2);
  });

  it('markUndone flips the flag and is idempotent', async () => {
    const row = await repo.append({ seriesId: 'sr-1', kind: 'merge', payload: {} });
    expect(row.undone).toBe(false);
    const u1 = await repo.markUndone(row.id);
    expect(u1.undone).toBe(true);
    const u2 = await repo.markUndone(row.id);
    expect(u2.undone).toBe(true);
    const fromDb = await repo.get(row.id);
    expect(fromDb?.undone).toBe(true);
  });

  it('markUndone throws after undoableUntil window', async () => {
    const row = await repo.append({ seriesId: 'sr-1', kind: 'merge', payload: {} });
    clock = row.undoableUntil + 1;
    await expect(repo.markUndone(row.id)).rejects.toThrow(/expired/);
  });

  it('markUndone throws when id missing', async () => {
    await expect(repo.markUndone('nope')).rejects.toThrow(/not found/);
  });

  it('gc deletes only entries past undoableUntil', async () => {
    clock = 100; const stale = await repo.append({ seriesId: 'A', kind: 'merge', payload: {} });
    clock = 200; const fresh = await repo.append({ seriesId: 'A', kind: 'split', payload: {} });
    clock = stale.undoableUntil + 5; // past stale, before fresh's window
    const deleted = await repo.gc();
    expect(deleted).toBe(1);
    expect(await repo.get(stale.id)).toBeNull();
    expect(await repo.get(fresh.id)).not.toBeNull();
  });

  it('gc handles empty store cleanly', async () => {
    expect(await repo.gc()).toBe(0);
  });
});

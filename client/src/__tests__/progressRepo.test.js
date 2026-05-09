import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../lib/library/db/db.js';
import { makeProgressRepo } from '../lib/library/db/progressRepo.js';

describe('progressRepo (P4-B)', () => {
  let testDb;

  beforeEach(async () => {
    testDb = getDb('test-progress-' + Date.now() + Math.random());
    await testDb.open();
  });

  it('put then get returns the stored progress (key = episodeId)', async () => {
    const repo = makeProgressRepo(testDb, { now: () => 5000 });
    await repo.put({
      episodeId: 'ep-1',
      seriesId: 'sr-1',
      positionSec: 120,
      durationSec: 1440,
      completed: false,
    });

    const got = await repo.get('ep-1');
    expect(got).toMatchObject({
      episodeId: 'ep-1',
      seriesId: 'sr-1',
      positionSec: 120,
      durationSec: 1440,
      completed: false,
      updatedAt: 5000,
    });
  });

  it('get returns null when episode has no recorded progress', async () => {
    const repo = makeProgressRepo(testDb);
    const got = await repo.get('does-not-exist');
    expect(got).toBeNull();
  });

  it('put is idempotent — last write wins on positionSec / updatedAt', async () => {
    let t = 1000;
    const repo = makeProgressRepo(testDb, { now: () => t });

    await repo.put({ episodeId: 'ep-1', seriesId: 'sr-1', positionSec: 60, durationSec: 1440, completed: false });
    t = 2000;
    await repo.put({ episodeId: 'ep-1', seriesId: 'sr-1', positionSec: 240, durationSec: 1440, completed: false });

    const got = await repo.get('ep-1');
    expect(got.positionSec).toBe(240);
    expect(got.updatedAt).toBe(2000);

    const count = await testDb.progress.count();
    expect(count).toBe(1);
  });

  it('put injects updatedAt from the clock if caller did not supply one', async () => {
    const repo = makeProgressRepo(testDb, { now: () => 9999 });
    await repo.put({ episodeId: 'ep-2', seriesId: 'sr-1', positionSec: 0, durationSec: 100, completed: false });
    const got = await repo.get('ep-2');
    expect(got.updatedAt).toBe(9999);
  });

  it('put preserves caller-supplied updatedAt (e.g. migration replay)', async () => {
    const repo = makeProgressRepo(testDb, { now: () => 9999 });
    await repo.put({
      episodeId: 'ep-mig',
      seriesId: 'sr-1',
      positionSec: 30,
      durationSec: 100,
      completed: false,
      updatedAt: 1234,
    });
    const got = await repo.get('ep-mig');
    expect(got.updatedAt).toBe(1234);
  });

  it('put rejects negative positionSec', async () => {
    const repo = makeProgressRepo(testDb);
    await expect(
      repo.put({ episodeId: 'bad', seriesId: 'sr-1', positionSec: -1, durationSec: 100, completed: false })
    ).rejects.toThrow(/positionSec/);
  });

  it('put rejects non-positive durationSec', async () => {
    const repo = makeProgressRepo(testDb);
    await expect(
      repo.put({ episodeId: 'bad', seriesId: 'sr-1', positionSec: 0, durationSec: 0, completed: false })
    ).rejects.toThrow(/durationSec/);
  });

  it('put requires episodeId and seriesId', async () => {
    const repo = makeProgressRepo(testDb);
    await expect(
      repo.put({ episodeId: '', seriesId: 'sr-1', positionSec: 0, durationSec: 100, completed: false })
    ).rejects.toThrow(/episodeId/);
    await expect(
      repo.put({ episodeId: 'ep', seriesId: '', positionSec: 0, durationSec: 100, completed: false })
    ).rejects.toThrow(/seriesId/);
  });

  it('getBySeries returns all progress entries for a series, newest first', async () => {
    let t = 1000;
    const repo = makeProgressRepo(testDb, { now: () => t });

    await repo.put({ episodeId: 'a', seriesId: 'sr-1', positionSec: 10, durationSec: 100, completed: false });
    t = 2000;
    await repo.put({ episodeId: 'b', seriesId: 'sr-1', positionSec: 20, durationSec: 100, completed: false });
    t = 1500;
    await repo.put({ episodeId: 'c', seriesId: 'sr-2', positionSec: 30, durationSec: 100, completed: false });

    const list = await repo.getBySeries('sr-1');
    expect(list.map(p => p.episodeId)).toEqual(['b', 'a']);
  });

  it('getBySeries returns empty array when series has no progress', async () => {
    const repo = makeProgressRepo(testDb);
    const list = await repo.getBySeries('sr-empty');
    expect(list).toEqual([]);
  });

  it('latestPerSeries returns one record per series (the newest), sorted newest first', async () => {
    let t = 1000;
    const repo = makeProgressRepo(testDb, { now: () => t });

    // sr-1: ep a then ep b (b is newer)
    await repo.put({ episodeId: 'a', seriesId: 'sr-1', positionSec: 10, durationSec: 100, completed: false });
    t = 2000;
    await repo.put({ episodeId: 'b', seriesId: 'sr-1', positionSec: 20, durationSec: 100, completed: false });

    // sr-2: only one ep, but newest among all
    t = 3000;
    await repo.put({ episodeId: 'c', seriesId: 'sr-2', positionSec: 30, durationSec: 100, completed: false });

    // sr-3: oldest
    t = 500;
    await repo.put({ episodeId: 'd', seriesId: 'sr-3', positionSec: 40, durationSec: 100, completed: false });

    const list = await repo.latestPerSeries();
    expect(list.map(p => p.seriesId)).toEqual(['sr-2', 'sr-1', 'sr-3']);
    expect(list.find(p => p.seriesId === 'sr-1').episodeId).toBe('b');
  });

  it('latestPerSeries respects a limit', async () => {
    let t = 1000;
    const repo = makeProgressRepo(testDb, { now: () => t });
    for (let i = 0; i < 5; i++) {
      t = 1000 + i;
      await repo.put({
        episodeId: `e${i}`,
        seriesId: `s${i}`,
        positionSec: 10,
        durationSec: 100,
        completed: false,
      });
    }
    const list = await repo.latestPerSeries({ limit: 3 });
    expect(list).toHaveLength(3);
    expect(list.map(p => p.seriesId)).toEqual(['s4', 's3', 's2']);
  });

  it('delete removes a single progress entry', async () => {
    const repo = makeProgressRepo(testDb);
    await repo.put({ episodeId: 'gone', seriesId: 'sr-1', positionSec: 10, durationSec: 100, completed: false });
    await repo.delete('gone');
    const got = await repo.get('gone');
    expect(got).toBeNull();
  });
});

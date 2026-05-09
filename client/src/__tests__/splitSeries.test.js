// @ts-check
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { getDb } from '../lib/library/db/db.js';
import { splitSeries } from '../services/splitSeries.js';

describe('splitSeries', () => {
  let db;

  beforeEach(async () => {
    db = getDb('test-split-' + Date.now() + Math.random());
    await db.open();

    // Source series with 3 seasons.
    await db.series.put({
      id: 'src-1',
      titleZh: '源系列',
      titleEn: 'Source',
      type: 'tv',
      confidence: 1,
      createdAt: 0,
      updatedAt: 0,
    });
    await db.seasons.bulkPut([
      { id: 'sn-1', seriesId: 'src-1', number: 1, animeId: 101, updatedAt: 0 },
      { id: 'sn-2', seriesId: 'src-1', number: 2, animeId: 102, updatedAt: 0 },
      { id: 'sn-3', seriesId: 'src-1', number: 3, animeId: 103, updatedAt: 0 },
    ]);
  });

  afterEach(async () => {
    if (db) {
      db.close();
      await new Promise((res) => {
        const req = indexedDB.deleteDatabase(db.name);
        req.onsuccess = res;
        req.onerror = res;
        req.onblocked = res;
      });
    }
  });

  it('creates a new series with the given name', async () => {
    const newId = await splitSeries({
      db,
      sourceSeriesId: 'src-1',
      seasonIds: ['sn-2'],
      name: 'Split Out',
      ulid: () => 'new-1',
      now: () => 1000,
    });
    expect(newId).toBe('new-1');
    const newSeries = await db.series.get('new-1');
    expect(newSeries).toBeTruthy();
    expect(newSeries.titleEn).toBe('Split Out');
    expect(newSeries.titleZh).toBe('Split Out');
  });

  it('reassigns the selected seasons to the new series', async () => {
    await splitSeries({
      db,
      sourceSeriesId: 'src-1',
      seasonIds: ['sn-2', 'sn-3'],
      name: 'Split',
      ulid: () => 'new-2',
      now: () => 1000,
    });
    const moved = await db.seasons.bulkGet(['sn-2', 'sn-3']);
    expect(moved.every((sn) => sn.seriesId === 'new-2')).toBe(true);
    const stayed = await db.seasons.get('sn-1');
    expect(stayed.seriesId).toBe('src-1');
  });

  it('writes a userOverride with splitFrom referencing the source', async () => {
    await splitSeries({
      db,
      sourceSeriesId: 'src-1',
      seasonIds: ['sn-2'],
      name: 'Split',
      ulid: () => 'new-3',
      now: () => 1234,
    });
    const ov = await db.userOverride.get('new-3');
    expect(ov).toBeTruthy();
    expect(ov.splitFrom).toBe('src-1');
    expect(ov.updatedAt).toBe(1234);
  });

  it('rejects when seasonIds is empty', async () => {
    await expect(
      splitSeries({
        db,
        sourceSeriesId: 'src-1',
        seasonIds: [],
        name: 'X',
        ulid: () => 'new-4',
      }),
    ).rejects.toThrow();
  });

  it('rejects when name is empty', async () => {
    await expect(
      splitSeries({
        db,
        sourceSeriesId: 'src-1',
        seasonIds: ['sn-2'],
        name: '   ',
        ulid: () => 'new-5',
      }),
    ).rejects.toThrow();
  });

  it('rejects when extracting all seasons (would be a rename, not a split)', async () => {
    await expect(
      splitSeries({
        db,
        sourceSeriesId: 'src-1',
        seasonIds: ['sn-1', 'sn-2', 'sn-3'],
        name: 'X',
        ulid: () => 'new-6',
      }),
    ).rejects.toThrow();
  });

  it('rejects when a seasonId does not belong to the source series', async () => {
    // sn-foreign belongs to a different series.
    await db.series.put({
      id: 'other',
      titleZh: '其它',
      type: 'tv',
      confidence: 1,
      createdAt: 0,
      updatedAt: 0,
    });
    await db.seasons.put({
      id: 'sn-foreign',
      seriesId: 'other',
      number: 1,
      animeId: 999,
      updatedAt: 0,
    });
    await expect(
      splitSeries({
        db,
        sourceSeriesId: 'src-1',
        seasonIds: ['sn-foreign'],
        name: 'X',
        ulid: () => 'new-7',
      }),
    ).rejects.toThrow();
  });

  it('atomicity: source series remains intact when something would fail mid-flight', async () => {
    // Ask for a non-existent season; whole txn must roll back.
    await expect(
      splitSeries({
        db,
        sourceSeriesId: 'src-1',
        seasonIds: ['sn-does-not-exist'],
        name: 'X',
        ulid: () => 'new-8',
      }),
    ).rejects.toThrow();
    const stillThere = await db.seasons
      .where('seriesId')
      .equals('src-1')
      .toArray();
    expect(stillThere).toHaveLength(3);
    const noSeries = await db.series.get('new-8');
    expect(noSeries).toBeUndefined();
    const noOverride = await db.userOverride.get('new-8');
    expect(noOverride).toBeUndefined();
  });
});

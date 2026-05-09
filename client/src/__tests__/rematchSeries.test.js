// @ts-check
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { getDb } from '../lib/library/db/db.js';
import { rematchSeries } from '../services/rematchSeries.js';

describe('rematchSeries', () => {
  let db;

  beforeEach(async () => {
    db = getDb('test-rematch-' + Date.now() + Math.random());
    await db.open();

    await db.series.put({
      id: 'src-1',
      titleZh: '错的标题',
      titleEn: 'Wrong Title',
      type: 'tv',
      confidence: 0.5,
      createdAt: 0,
      updatedAt: 0,
    });
    await db.seasons.bulkPut([
      { id: 'sn-1', seriesId: 'src-1', number: 1, animeId: 9999, updatedAt: 0 },
      { id: 'sn-2', seriesId: 'src-1', number: 2, animeId: 9998, updatedAt: 0 },
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

  it('updates the primary (lowest-number) season animeId', async () => {
    await rematchSeries({
      db,
      seriesId: 'src-1',
      animeId: 12345,
      ulid: () => 'new-x',
      now: () => 5000,
    });
    const sn1 = await db.seasons.get('sn-1');
    expect(sn1.animeId).toBe(12345);
    const sn2 = await db.seasons.get('sn-2');
    expect(sn2.animeId).toBe(9998);
  });

  it('updates series record fields when provided', async () => {
    await rematchSeries({
      db,
      seriesId: 'src-1',
      animeId: 12345,
      titleZh: '正确标题',
      titleEn: 'Correct Title',
      posterUrl: 'https://example.com/p.jpg',
      type: 'tv',
      ulid: () => 'new-x',
      now: () => 5000,
    });
    const s = await db.series.get('src-1');
    expect(s.titleZh).toBe('正确标题');
    expect(s.titleEn).toBe('Correct Title');
    expect(s.posterUrl).toBe('https://example.com/p.jpg');
    expect(s.type).toBe('tv');
    expect(s.updatedAt).toBe(5000);
  });

  it('writes userOverride with locked=true and overrideSeasonAnimeId', async () => {
    await rematchSeries({
      db,
      seriesId: 'src-1',
      animeId: 12345,
      ulid: () => 'new-x',
      now: () => 5000,
    });
    const ov = await db.userOverride.get('src-1');
    expect(ov).toBeTruthy();
    expect(ov.locked).toBe(true);
    expect(ov.overrideSeasonAnimeId).toBe(12345);
    expect(ov.updatedAt).toBe(5000);
  });

  it('merges with an existing userOverride (preserves mergedFrom/splitFrom)', async () => {
    await db.userOverride.put({
      seriesId: 'src-1',
      mergedFrom: ['old-1'],
      splitFrom: 'parent-1',
      updatedAt: 100,
    });
    await rematchSeries({
      db,
      seriesId: 'src-1',
      animeId: 12345,
      ulid: () => 'new-x',
      now: () => 5000,
    });
    const ov = await db.userOverride.get('src-1');
    expect(ov.mergedFrom).toEqual(['old-1']);
    expect(ov.splitFrom).toBe('parent-1');
    expect(ov.locked).toBe(true);
    expect(ov.overrideSeasonAnimeId).toBe(12345);
  });

  it('creates a new season when the series has no seasons', async () => {
    await db.series.put({
      id: 'orphan',
      titleZh: '空',
      type: 'tv',
      confidence: 0.5,
      createdAt: 0,
      updatedAt: 0,
    });
    await rematchSeries({
      db,
      seriesId: 'orphan',
      animeId: 7777,
      ulid: () => 'new-season-id',
      now: () => 6000,
    });
    const seasons = await db.seasons.where('seriesId').equals('orphan').toArray();
    expect(seasons).toHaveLength(1);
    expect(seasons[0].id).toBe('new-season-id');
    expect(seasons[0].animeId).toBe(7777);
    expect(seasons[0].number).toBe(1);
  });

  it('rejects when seriesId is empty', async () => {
    await expect(
      rematchSeries({
        db,
        seriesId: '',
        animeId: 12345,
        ulid: () => 'x',
      }),
    ).rejects.toThrow();
  });

  it('rejects when animeId is not a positive integer', async () => {
    await expect(
      rematchSeries({ db, seriesId: 'src-1', animeId: 0, ulid: () => 'x' }),
    ).rejects.toThrow();
    await expect(
      rematchSeries({ db, seriesId: 'src-1', animeId: -5, ulid: () => 'x' }),
    ).rejects.toThrow();
    await expect(
      rematchSeries({ db, seriesId: 'src-1', animeId: 1.5, ulid: () => 'x' }),
    ).rejects.toThrow();
  });

  it('rejects when the series does not exist', async () => {
    await expect(
      rematchSeries({
        db,
        seriesId: 'does-not-exist',
        animeId: 12345,
        ulid: () => 'x',
      }),
    ).rejects.toThrow();
  });

  it('atomicity: a mid-flight failure rolls back all writes', async () => {
    // Force a failure by passing an invalid animeId for the userOverride validator.
    // (animeId is checked at the top, so we exercise atomicity differently: mock a
    // throwing ulid for the no-season branch.)
    await db.series.put({
      id: 'orphan-2',
      titleZh: '空2',
      type: 'tv',
      confidence: 0.5,
      createdAt: 0,
      updatedAt: 100,
    });
    await expect(
      rematchSeries({
        db,
        seriesId: 'orphan-2',
        animeId: 4444,
        ulid: () => { throw new Error('boom'); },
        now: () => 7000,
      }),
    ).rejects.toThrow();
    // Original series untouched
    const s = await db.series.get('orphan-2');
    expect(s.updatedAt).toBe(100);
    // No season created
    const seasons = await db.seasons.where('seriesId').equals('orphan-2').toArray();
    expect(seasons).toHaveLength(0);
    // No override written
    const ov = await db.userOverride.get('orphan-2');
    expect(ov).toBeUndefined();
  });
});

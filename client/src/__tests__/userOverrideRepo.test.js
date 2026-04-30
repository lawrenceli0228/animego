import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../lib/library/db/db.js';
import { makeUserOverrideRepo } from '../lib/library/db/userOverrideRepo.js';

describe('userOverrideRepo (P4-F foundation)', () => {
  let testDb;
  let repo;

  beforeEach(async () => {
    testDb = getDb('test-userOverride-' + Date.now() + Math.random());
    await testDb.open();
    repo = makeUserOverrideRepo(testDb, { now: () => 9999 });
  });

  it('get returns null when no override exists', async () => {
    const result = await repo.get('sr-missing');
    expect(result).toBeNull();
  });

  it('put + get round trip', async () => {
    await repo.put({
      seriesId: 'sr-1',
      locked: true,
      overrideSeasonAnimeId: 12345,
    });
    const got = await repo.get('sr-1');
    expect(got).toMatchObject({
      seriesId: 'sr-1',
      locked: true,
      overrideSeasonAnimeId: 12345,
      updatedAt: 9999,
    });
  });

  it('put preserves caller-supplied updatedAt when given', async () => {
    await repo.put({ seriesId: 'sr-2', locked: false, updatedAt: 5_000 });
    const got = await repo.get('sr-2');
    expect(got.updatedAt).toBe(5_000);
  });

  it('put is idempotent — second write replaces the first (last-write-wins)', async () => {
    await repo.put({ seriesId: 'sr-3', locked: false, updatedAt: 1_000 });
    await repo.put({ seriesId: 'sr-3', locked: true, updatedAt: 2_000 });
    const got = await repo.get('sr-3');
    expect(got.locked).toBe(true);
    expect(got.updatedAt).toBe(2_000);
    expect(await testDb.userOverride.count()).toBe(1);
  });

  it('put rejects empty seriesId', async () => {
    await expect(repo.put({ seriesId: '' })).rejects.toThrow(/seriesId/);
    await expect(repo.put({ seriesId: undefined })).rejects.toThrow(/seriesId/);
  });

  it('put rejects non-positive overrideSeasonAnimeId', async () => {
    await expect(repo.put({ seriesId: 'sr-x', overrideSeasonAnimeId: 0 })).rejects.toThrow(/overrideSeasonAnimeId/);
    await expect(repo.put({ seriesId: 'sr-x', overrideSeasonAnimeId: -1 })).rejects.toThrow(/overrideSeasonAnimeId/);
    await expect(repo.put({ seriesId: 'sr-x', overrideSeasonAnimeId: 1.5 })).rejects.toThrow(/overrideSeasonAnimeId/);
  });

  it('put rejects mergedFrom containing non-strings or empty strings', async () => {
    await expect(repo.put({ seriesId: 'sr-x', mergedFrom: ['ok', ''] })).rejects.toThrow(/mergedFrom/);
    await expect(repo.put({ seriesId: 'sr-x', mergedFrom: ['ok', 7] })).rejects.toThrow(/mergedFrom/);
  });

  it('update merges partial fields atomically into existing record', async () => {
    await repo.put({ seriesId: 'sr-merge', locked: true, normalizedTokens: ['attack', 'titan'] });
    const merged = await repo.update('sr-merge', { overrideSeasonAnimeId: 4242 });
    expect(merged).toMatchObject({
      seriesId: 'sr-merge',
      locked: true,
      normalizedTokens: ['attack', 'titan'],
      overrideSeasonAnimeId: 4242,
      updatedAt: 9999,
    });
    // And it persisted
    const reread = await repo.get('sr-merge');
    expect(reread.overrideSeasonAnimeId).toBe(4242);
  });

  it('update creates a new record when none exists yet', async () => {
    const merged = await repo.update('sr-new', { locked: true });
    expect(merged).toMatchObject({ seriesId: 'sr-new', locked: true, updatedAt: 9999 });
    expect(await repo.get('sr-new')).not.toBeNull();
  });

  it('delete removes the record; subsequent get returns null', async () => {
    await repo.put({ seriesId: 'sr-del', locked: true });
    await repo.delete('sr-del');
    expect(await repo.get('sr-del')).toBeNull();
  });

  it('delete is a no-op when the record does not exist', async () => {
    await expect(repo.delete('sr-nope')).resolves.toBeUndefined();
  });

  it('getMany returns a Map keyed by seriesId, missing keys absent', async () => {
    await repo.put({ seriesId: 'sr-A', locked: true });
    await repo.put({ seriesId: 'sr-B', overrideSeasonAnimeId: 1 });
    const map = await repo.getMany(['sr-A', 'sr-B', 'sr-MISSING']);
    expect(map.get('sr-A')).toMatchObject({ locked: true });
    expect(map.get('sr-B')).toMatchObject({ overrideSeasonAnimeId: 1 });
    expect(map.has('sr-MISSING')).toBe(false);
    expect(map.size).toBe(2);
  });

  it('getMany returns an empty Map for empty input', async () => {
    const map = await repo.getMany([]);
    expect(map.size).toBe(0);
  });

  it('list returns all overrides sorted by updatedAt desc', async () => {
    await repo.put({ seriesId: 'sr-old', locked: true, updatedAt: 1 });
    await repo.put({ seriesId: 'sr-mid', locked: true, updatedAt: 5 });
    await repo.put({ seriesId: 'sr-new', locked: true, updatedAt: 10 });
    const all = await repo.list();
    expect(all.map(r => r.seriesId)).toEqual(['sr-new', 'sr-mid', 'sr-old']);
  });
});

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../lib/library/db/db.js';
import { makeSeasonRepo } from '../lib/library/db/seasonRepo.js';

function makeSeason({ id = 'sn1', seriesId = 'sr1', animeId = 10, number = 1 } = {}) {
  return { id, seriesId, number, animeId, updatedAt: Date.now() };
}

describe('seasonRepo (Slice 5)', () => {
  let repo;
  let testDb;

  beforeEach(async () => {
    testDb = getDb('test-season-repo-' + Date.now() + Math.random());
    await testDb.open();
    repo = makeSeasonRepo(testDb);
  });

  it('findByAnimeId returns matching season', async () => {
    await testDb.seasons.put(makeSeason({ animeId: 99 }));
    const results = await repo.findByAnimeId(99);
    expect(results).toHaveLength(1);
    expect(results[0].animeId).toBe(99);
  });

  it('findByAnimeId returns empty array when no match', async () => {
    const results = await repo.findByAnimeId(9999);
    expect(results).toEqual([]);
  });

  it('findBySeries returns all seasons for a seriesId', async () => {
    await testDb.seasons.bulkPut([
      makeSeason({ id: 'sn1', seriesId: 'sr-a', animeId: 1 }),
      makeSeason({ id: 'sn2', seriesId: 'sr-a', animeId: 2, number: 2 }),
      makeSeason({ id: 'sn3', seriesId: 'sr-b', animeId: 3 }),
    ]);
    const results = await repo.findBySeries('sr-a');
    expect(results).toHaveLength(2);
    expect(results.map(s => s.id).sort()).toEqual(['sn1', 'sn2']);
  });

  it('findBySeries returns empty array for unknown seriesId', async () => {
    const results = await repo.findBySeries('unknown');
    expect(results).toEqual([]);
  });
});

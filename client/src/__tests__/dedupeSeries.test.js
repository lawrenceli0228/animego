// @ts-check
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../lib/library/db/db.js';
import { dedupeSeriesByAnimeId } from '../services/dedupeSeries.js';

function series(id, createdAt = 0, title = 'X') {
  return { id, titleZh: title, type: 'tv', confidence: 0.9, createdAt, updatedAt: createdAt };
}
function season(id, seriesId, animeId) {
  return { id, seriesId, number: 1, animeId, updatedAt: 0 };
}

describe('dedupeSeriesByAnimeId', () => {
  let db;
  beforeEach(async () => {
    db = getDb('test-dedupe-' + Date.now() + Math.random());
    await db.open();
  });

  it('merges duplicate Series sharing one animeId, keeping the oldest as target', async () => {
    await db.series.bulkPut([
      series('s-newer', 200),
      series('s-oldest', 100),
      series('s-middle', 150),
    ]);
    await db.seasons.bulkPut([
      season('sn-1', 's-newer', 515759),
      season('sn-2', 's-oldest', 515759),
      season('sn-3', 's-middle', 515759),
    ]);

    const result = await dedupeSeriesByAnimeId({ db });

    expect(result.groups).toBe(1);
    expect(result.merged).toBe(2);
    expect(result.pairs.every((p) => p.targetSeriesId === 's-oldest')).toBe(true);
    expect(result.pairs.map((p) => p.sourceSeriesId).sort()).toEqual(['s-middle', 's-newer']);

    // Both sources end up in s-oldest's mergedFrom
    const override = await db.userOverride.get('s-oldest');
    expect(override?.mergedFrom?.sort()).toEqual(['s-middle', 's-newer']);
  });

  it('handles multiple duplicate groups independently', async () => {
    await db.series.bulkPut([
      series('a1', 100), series('a2', 200),  // animeId 1
      series('b1', 100), series('b2', 200),  // animeId 2
    ]);
    await db.seasons.bulkPut([
      season('sa1', 'a1', 1), season('sa2', 'a2', 1),
      season('sb1', 'b1', 2), season('sb2', 'b2', 2),
    ]);

    const result = await dedupeSeriesByAnimeId({ db });

    expect(result.groups).toBe(2);
    expect(result.merged).toBe(2);
  });

  it('skips groups with only one Series (not a duplicate)', async () => {
    await db.series.put(series('lone', 0));
    await db.seasons.put(season('sn', 'lone', 999));
    const result = await dedupeSeriesByAnimeId({ db });
    expect(result.groups).toBe(0);
    expect(result.merged).toBe(0);
  });

  it('returns zero summary on an empty library', async () => {
    const result = await dedupeSeriesByAnimeId({ db });
    expect(result).toEqual({ groups: 0, merged: 0, skipped: 0, pairs: [], opIds: [] });
  });

  it('treats a season missing animeId as no group', async () => {
    await db.series.bulkPut([series('s1', 100), series('s2', 200)]);
    await db.seasons.bulkPut([
      { id: 'sn1', seriesId: 's1', number: 1, animeId: undefined, updatedAt: 0 },
      season('sn2', 's2', 12345),  // only s2 has animeId
    ]);
    const result = await dedupeSeriesByAnimeId({ db });
    expect(result.groups).toBe(0);
  });

  it('counts a re-run as fully skipped (idempotent)', async () => {
    await db.series.bulkPut([series('a1', 100), series('a2', 200)]);
    await db.seasons.bulkPut([season('sa1', 'a1', 1), season('sa2', 'a2', 1)]);

    const first = await dedupeSeriesByAnimeId({ db });
    expect(first.merged).toBe(1);

    const second = await dedupeSeriesByAnimeId({ db });
    expect(second.groups).toBe(1);
    expect(second.merged).toBe(0);
    expect(second.skipped).toBe(1);
  });
});

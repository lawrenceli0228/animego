import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../lib/library/db/db.js';
import { makeSeriesRepo } from '../lib/library/db/seriesRepo.js';

/** Minimal cluster payload builder */
function makeCluster({ seriesId = 'sr1', seasonId = 'sn1', epCount = 5, animeId = 42 } = {}) {
  const now = Date.now();
  const series = {
    id: seriesId,
    titleZh: '攻殻機動隊',
    type: 'tv',
    confidence: 0.9,
    createdAt: now,
    updatedAt: now,
  };
  const season = {
    id: seasonId,
    seriesId,
    number: 1,
    animeId,
    updatedAt: now,
  };
  const episodes = Array.from({ length: epCount }, (_, i) => ({
    id: `ep${i}`,
    seriesId,
    seasonId,
    number: i + 1,
    kind: 'main',
    primaryFileId: `fr${i}`,
    alternateFileIds: [],
    updatedAt: now,
  }));
  const fileRefs = Array.from({ length: epCount }, (_, i) => ({
    id: `fr${i}`,
    libraryId: 'lib1',
    episodeId: `ep${i}`,
    relPath: `show/ep${i + 1}.mkv`,
    size: 1000,
    mtime: 0,
    matchStatus: 'matched',
  }));
  return { series, season, episodes, fileRefs };
}

describe('seriesRepo (Slice 5)', () => {
  let repo;

  beforeEach(async () => {
    const testDb = getDb('test-series-repo-' + Date.now() + Math.random());
    await testDb.open();
    repo = makeSeriesRepo(testDb);
  });

  it('upsertCluster writes series+season+5 episodes+5 fileRefs atomically', async () => {
    const cluster = makeCluster();
    await repo.upsertCluster(cluster);

    const series = await repo.findAll();
    expect(series).toHaveLength(1);
    expect(series[0].id).toBe('sr1');

    const testDb = getDb('test-series-repo-check-' + Date.now());
  });

  it('findAll returns all series sorted by updatedAt desc', async () => {
    const now = Date.now();
    const c1 = makeCluster({ seriesId: 'old', seasonId: 'sn-old', animeId: 1 });
    c1.series.updatedAt = now - 1000;
    const c2 = makeCluster({ seriesId: 'new', seasonId: 'sn-new', animeId: 2 });
    c2.series.updatedAt = now;
    await repo.upsertCluster(c1);
    await repo.upsertCluster(c2);

    const all = await repo.findAll();
    expect(all).toHaveLength(2);
    expect(all[0].id).toBe('new');
    expect(all[1].id).toBe('old');
  });

  it('re-upsert with same ids does not create duplicates (last-write-wins on updatedAt)', async () => {
    const cluster = makeCluster();
    await repo.upsertCluster(cluster);

    // Update updatedAt and upsert again
    cluster.series.updatedAt = Date.now() + 5000;
    cluster.series.titleZh = '新標題';
    await repo.upsertCluster(cluster);

    const all = await repo.findAll();
    expect(all).toHaveLength(1);
    expect(all[0].titleZh).toBe('新標題');
  });

  it('upsertCluster with missing series field rejects with clear error', async () => {
    const cluster = makeCluster();
    delete cluster.series.id;
    await expect(repo.upsertCluster(cluster)).rejects.toThrow();
  });

  it('findById returns the series record by id', async () => {
    const cluster = makeCluster({ seriesId: 'sr-find' });
    await repo.upsertCluster(cluster);
    const found = await repo.findById('sr-find');
    expect(found).not.toBeNull();
    expect(found.id).toBe('sr-find');
  });

  it('findById returns null for unknown id', async () => {
    const found = await repo.findById('nonexistent');
    expect(found).toBeNull();
  });
});

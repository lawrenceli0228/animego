// @ts-check
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../lib/library/db/db.js';
import { deleteSeriesCascade } from '../services/deleteSeries.js';

function ep(id, seriesId, primaryFileId, alternates = []) {
  return {
    id, seriesId, number: 1, kind: 'main',
    primaryFileId, alternateFileIds: alternates, updatedAt: 0,
  };
}
function ref(id, libraryId = 'lib') {
  return { id, libraryId, relPath: id + '.mkv', size: 1024, mtime: 0, matchStatus: 'matched' };
}
function series(id, title = 'X') {
  return { id, titleZh: title, type: 'tv', confidence: 0.9, createdAt: 0, updatedAt: 0 };
}

describe('deleteSeriesCascade', () => {
  let db;
  beforeEach(async () => {
    db = getDb('test-del-' + Date.now() + Math.random());
    await db.open();
  });

  it('removes series + episodes + owned fileRefs + progress + userOverride in one shot', async () => {
    await db.series.put(series('s1'));
    await db.seasons.put({ id: 'season-1', seriesId: 's1', number: 1, animeId: 100, updatedAt: 0 });
    await db.episodes.bulkPut([ep('e1', 's1', 'f1'), ep('e2', 's1', 'f2', ['f2alt'])]);
    await db.fileRefs.bulkPut([ref('f1'), ref('f2'), ref('f2alt')]);
    await db.progress.put({ episodeId: 'e1', seriesId: 's1', positionSec: 30, durationSec: 1440, updatedAt: 0, completed: false });
    await db.userOverride.put({ seriesId: 's1', locked: true, updatedAt: 0 });

    const summary = await deleteSeriesCascade({ db, seriesId: 's1' });

    expect(summary).toEqual({
      seriesId: 's1',
      episodes: 2,
      seasons: 1,
      fileRefs: 3,
      progress: 1,
      userOverride: true,
    });
    expect(await db.series.get('s1')).toBeUndefined();
    expect(await db.episodes.get('e1')).toBeUndefined();
    expect(await db.fileRefs.get('f1')).toBeUndefined();
    expect(await db.fileRefs.get('f2alt')).toBeUndefined();
    expect(await db.seasons.get('season-1')).toBeUndefined();
  });

  it('preserves a fileRef that another series still references (post-merge edge)', async () => {
    await db.series.bulkPut([series('s1'), series('s2', 'Other')]);
    await db.episodes.bulkPut([
      ep('e1', 's1', 'shared'),
      ep('e2', 's2', 'shared'),  // s2 also points at 'shared'
    ]);
    await db.fileRefs.put(ref('shared'));

    await deleteSeriesCascade({ db, seriesId: 's1' });

    expect(await db.series.get('s1')).toBeUndefined();
    expect(await db.episodes.get('e1')).toBeUndefined();
    // shared fileRef must survive because s2 still uses it
    expect(await db.fileRefs.get('shared')).toBeDefined();
    // s2 itself untouched
    expect(await db.series.get('s2')).toBeDefined();
    expect(await db.episodes.get('e2')).toBeDefined();
  });

  it('is a noop on a missing seriesId — returns zero summary, no throw', async () => {
    const summary = await deleteSeriesCascade({ db, seriesId: 'missing' });
    expect(summary).toEqual({
      seriesId: 'missing',
      episodes: 0,
      seasons: 0,
      fileRefs: 0,
      progress: 0,
      userOverride: false,
    });
  });

  it('rejects a non-string seriesId', async () => {
    await expect(deleteSeriesCascade({ db, seriesId: '' })).rejects.toThrow();
    await expect(deleteSeriesCascade({ db, seriesId: null })).rejects.toThrow();
  });

  it('does NOT touch fileHandles or matchCache', async () => {
    await db.series.put(series('s1'));
    await db.episodes.put(ep('e1', 's1', 'f1'));
    await db.fileRefs.put({ ...ref('f1'), hash16M: 'abc123' });
    await db.fileHandles.put({ id: 'h1', libraryId: 'lib', name: 'root', addedAt: 0, lastSeenAt: 0 });
    await db.matchCache.put({ hash16M: 'abc123', kind: 'new', animeId: 9999, updatedAt: 0 });

    await deleteSeriesCascade({ db, seriesId: 's1' });

    expect(await db.fileHandles.get('h1')).toBeDefined();
    expect(await db.matchCache.get('abc123')).toBeDefined();
  });
});

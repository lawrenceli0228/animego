import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../lib/library/db/db.js';
import { makeFileRefRepo } from '../lib/library/db/fileRefRepo.js';

function makeFileRef({ id = 'fr1', libraryId = 'lib1', episodeId = 'ep1', matchStatus = 'pending' } = {}) {
  return {
    id,
    libraryId,
    episodeId,
    relPath: `show/${id}.mkv`,
    size: 1024,
    mtime: 0,
    matchStatus,
  };
}

describe('fileRefRepo (Slice 5)', () => {
  let repo;
  let testDb;

  beforeEach(async () => {
    testDb = getDb('test-fileref-repo-' + Date.now() + Math.random());
    await testDb.open();
    repo = makeFileRefRepo(testDb);
  });

  it('findByMatchStatus uses compound index and returns matching records', async () => {
    await testDb.fileRefs.bulkPut([
      makeFileRef({ id: 'fr1', libraryId: 'lib1', matchStatus: 'pending' }),
      makeFileRef({ id: 'fr2', libraryId: 'lib1', matchStatus: 'matched' }),
      makeFileRef({ id: 'fr3', libraryId: 'lib1', matchStatus: 'pending' }),
      makeFileRef({ id: 'fr4', libraryId: 'lib2', matchStatus: 'pending' }),
    ]);
    const results = await repo.findByMatchStatus('lib1', 'pending');
    expect(results).toHaveLength(2);
    expect(results.every(r => r.libraryId === 'lib1' && r.matchStatus === 'pending')).toBe(true);
  });

  it('findByMatchStatus count matches manual filter (index correctness)', async () => {
    const records = Array.from({ length: 10 }, (_, i) => makeFileRef({
      id: `fr${i}`,
      libraryId: 'lib1',
      matchStatus: i % 3 === 0 ? 'matched' : 'pending',
    }));
    await testDb.fileRefs.bulkPut(records);

    const fromRepo = await repo.findByMatchStatus('lib1', 'matched');
    const fromFilter = records.filter(r => r.libraryId === 'lib1' && r.matchStatus === 'matched');
    expect(fromRepo).toHaveLength(fromFilter.length);
  });

  it('setEpisode updates episodeId on a fileRef', async () => {
    await testDb.fileRefs.put(makeFileRef({ id: 'fr-set', episodeId: 'old-ep' }));
    await repo.setEpisode('fr-set', 'new-ep');
    const updated = await testDb.fileRefs.get('fr-set');
    expect(updated.episodeId).toBe('new-ep');
  });

  it('markMissing sets matchStatus=failed and clears episodeId', async () => {
    await testDb.fileRefs.put(makeFileRef({ id: 'fr-miss', episodeId: 'ep-x', matchStatus: 'matched' }));
    await repo.markMissing('fr-miss');
    const updated = await testDb.fileRefs.get('fr-miss');
    expect(updated.matchStatus).toBe('failed');
    expect(updated.episodeId).toBeUndefined();
  });
});

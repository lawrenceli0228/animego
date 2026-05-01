// @ts-check
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { getDb } from '../lib/library/db/db.js';
import useSeriesLibraryStatus from '../hooks/useSeriesLibraryStatus.js';

function ep(id, seriesId, primaryFileId) {
  return {
    id, seriesId, number: 1, kind: 'main',
    primaryFileId, alternateFileIds: [], updatedAt: 0,
  };
}

function ref(id, libraryId) {
  return { id, libraryId, relPath: id + '.mkv', size: 1024, mtime: 0, matchStatus: 'matched' };
}

describe('useSeriesLibraryStatus', () => {
  let db;

  beforeEach(async () => {
    db = getDb('test-usls-' + Date.now() + Math.random());
    await db.open();
  });

  it('all libraries ready → series is "ok"', async () => {
    await db.episodes.bulkPut([ep('e1', 's1', 'f1'), ep('e2', 's1', 'f2')]);
    await db.fileRefs.bulkPut([ref('f1', 'lib-A'), ref('f2', 'lib-A')]);

    const libraryStatus = new Map([['lib-A', 'ready']]);
    const { result } = renderHook(() => useSeriesLibraryStatus({ db, libraryStatus }));

    await waitFor(() => {
      expect(result.current.availabilityBySeries.get('s1')).toBe('ok');
    });
    expect(result.current.offlineLibraryIds).toEqual([]);
  });

  it('single offline library → series is "offline" and reported in offlineLibraryIds', async () => {
    await db.episodes.bulkPut([ep('e1', 's1', 'f1')]);
    await db.fileRefs.bulkPut([ref('f1', 'lib-OFF')]);

    const libraryStatus = new Map([['lib-OFF', 'disconnected']]);
    const { result } = renderHook(() => useSeriesLibraryStatus({ db, libraryStatus }));

    await waitFor(() => {
      expect(result.current.availabilityBySeries.get('s1')).toBe('offline');
    });
    expect(result.current.offlineLibraryIds).toEqual(['lib-OFF']);
  });

  it('series spans two libraries, one offline → "partial"', async () => {
    await db.episodes.bulkPut([
      ep('e1', 's1', 'f1'),
      ep('e2', 's1', 'f2'),
    ]);
    await db.fileRefs.bulkPut([
      ref('f1', 'lib-OK'),
      ref('f2', 'lib-OFF'),
    ]);

    const libraryStatus = new Map([
      ['lib-OK', 'ready'],
      ['lib-OFF', 'disconnected'],
    ]);
    const { result } = renderHook(() => useSeriesLibraryStatus({ db, libraryStatus }));

    await waitFor(() => {
      expect(result.current.availabilityBySeries.get('s1')).toBe('partial');
    });
  });

  it('denied counts as offline (player can\'t reach files either way)', async () => {
    await db.episodes.bulkPut([ep('e1', 's1', 'f1')]);
    await db.fileRefs.bulkPut([ref('f1', 'lib-DEN')]);

    const libraryStatus = new Map([['lib-DEN', 'denied']]);
    const { result } = renderHook(() => useSeriesLibraryStatus({ db, libraryStatus }));

    await waitFor(() => {
      expect(result.current.availabilityBySeries.get('s1')).toBe('offline');
    });
    // denied is not 'disconnected', so it doesn't surface in the offline-drives banner
    expect(result.current.offlineLibraryIds).toEqual([]);
  });

  it('libraryStatus undefined → tolerates and yields "unknown" for all', async () => {
    await db.episodes.bulkPut([ep('e1', 's1', 'f1')]);
    await db.fileRefs.bulkPut([ref('f1', 'lib-?')]);

    const { result } = renderHook(() => useSeriesLibraryStatus({ db, libraryStatus: undefined }));

    await waitFor(() => {
      expect(result.current.availabilityBySeries.get('s1')).toBe('unknown');
    });
  });
});

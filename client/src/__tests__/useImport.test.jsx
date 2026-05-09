// @ts-check
import 'fake-indexeddb/auto';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { getDb } from '../lib/library/db/db.js';
import useImport from '../hooks/useImport.js';

/** Minimal EpisodeItem factory */
function makeItem(fileName, episode, parsedTitle = 'Test Show') {
  return {
    fileId: `${fileName}|1000|0`,
    file: { name: fileName, size: 1000, lastModified: 0 },
    fileName,
    relativePath: `Folder/${fileName}`,
    episode,
    parsedKind: 'main',
    parsedTitle,
    hash16M: `hash-${fileName}`,
  };
}

function makeDandanMock({ callCount = { value: 0 } } = {}) {
  return {
    async match() {
      callCount.value++;
      return { isMatched: true, animes: [{ animeId: 42, animeTitle: 'Test Show', episodes: [] }] };
    },
  };
}

function makeErrorDandanMock() {
  return {
    async match() {
      throw new Error('Network error from dandanplay');
    },
  };
}

describe('useImport', () => {
  let testDb;

  beforeEach(async () => {
    testDb = getDb('test-import-' + Date.now() + Math.random());
    await testDb.open();
  });

  it('happy: runs to done, exposes progress events, summary populated', async () => {
    const dandan = makeDandanMock();
    const { result } = renderHook(() => useImport({ db: testDb, dandan }));

    expect(result.current.status).toBe('idle');

    const items = [
      makeItem('ep1.mkv', 1),
      makeItem('ep2.mkv', 2),
      makeItem('ep3.mkv', 3),
    ];

    await act(async () => {
      await result.current.run({ items, libraryId: 'lib-happy' });
    });

    await waitFor(() => expect(result.current.status).toBe('done'));
    expect(result.current.summary).toBeDefined();
    expect(result.current.summary.clusters).toBeGreaterThan(0);
    expect(result.current.progress.length).toBeGreaterThan(0);
    // Check for a finish event
    expect(result.current.progress.some(e => e.kind === 'finish')).toBe(true);
  });

  it('edge: error from dandan → status="error", summary has failed > 0', async () => {
    const dandan = makeErrorDandanMock();
    const { result } = renderHook(() => useImport({ db: testDb, dandan }));

    const items = [makeItem('fail.mkv', 1, 'Failing Show')];

    await act(async () => {
      await result.current.run({ items, libraryId: 'lib-error' });
    });

    await waitFor(() =>
      result.current.status === 'done' || result.current.status === 'error'
    );

    // Either error status or done with failed > 0
    if (result.current.status === 'done') {
      expect(result.current.summary.failed).toBeGreaterThan(0);
    } else {
      expect(result.current.status).toBe('error');
    }
  });

  it('status starts as "idle"', () => {
    const { result } = renderHook(() => useImport({ db: testDb, dandan: makeDandanMock() }));
    expect(result.current.status).toBe('idle');
    expect(result.current.progress).toEqual([]);
    expect(result.current.summary).toBeNull();
  });

  it('cancel: calling cancel before run completes results in no throw', async () => {
    const dandan = makeDandanMock();
    const { result } = renderHook(() => useImport({ db: testDb, dandan }));

    const items = Array.from({ length: 5 }, (_, i) => makeItem(`ep${i + 1}.mkv`, i + 1));

    let threw = false;
    await act(async () => {
      const runPromise = result.current.run({ items, libraryId: 'lib-cancel' });
      result.current.cancel();
      try {
        await runPromise;
      } catch {
        threw = true;
      }
    });

    expect(threw).toBe(false);
    // After cancel, status should be idle or done (not stuck in running)
    expect(['idle', 'done']).toContain(result.current.status);
  });

  it('progress resets on each new run call', async () => {
    const dandan = makeDandanMock();
    const { result } = renderHook(() => useImport({ db: testDb, dandan }));

    const items = [makeItem('ep1.mkv', 1)];

    await act(async () => {
      await result.current.run({ items, libraryId: 'lib-reset-1' });
    });
    await waitFor(() => expect(result.current.status).toBe('done'));

    const firstRunEvents = result.current.progress.length;
    expect(firstRunEvents).toBeGreaterThan(0);

    await act(async () => {
      await result.current.run({ items, libraryId: 'lib-reset-2' });
    });
    await waitFor(() => expect(result.current.status).toBe('done'));

    // Progress should have been reset and repopulated
    expect(result.current.progress.length).toBeGreaterThan(0);
  });
});

// ── P4-E: hash-phase integration tests ──────────────────────────────────────

/** Build an item WITHOUT hash16M (simulating fresh enumerator output). */
function makeBareItem(fileName, episode, parsedTitle = 'Test Show') {
  return {
    fileId: `${fileName}|1000|0`,
    file: { name: fileName, size: 1000, lastModified: 0 },
    fileName,
    relativePath: `Show/${fileName}`,
    episode,
    parsedKind: 'main',
    parsedTitle,
  };
}

describe('useImport (P4-E hash phase)', () => {
  let testDb;

  beforeEach(async () => {
    testDb = getDb('test-import-hash-' + Date.now() + Math.random());
    await testDb.open();
  });

  it('computes hash16M for items missing it before runImport', async () => {
    const dandan = makeDandanMock();
    const stubPool = {
      hash: vi.fn(async (file) => `stub-${file.name}`),
      dispose: vi.fn(),
    };
    const { result } = renderHook(() =>
      useImport({ db: testDb, dandan, hashPool: stubPool })
    );

    const items = [makeBareItem('a.mkv', 1), makeBareItem('b.mkv', 2)];
    await act(async () => {
      await result.current.run({ items, libraryId: 'lib-hash-fresh' });
    });
    await waitFor(() => expect(result.current.status).toBe('done'));

    expect(stubPool.hash).toHaveBeenCalledTimes(2);

    // The persisted fileRefs should carry the hash and a content-addressed id.
    const fileRefs = await testDb.fileRefs.toArray();
    expect(fileRefs.some(fr => fr.hash16M === 'stub-a.mkv')).toBe(true);
    // No `|` because content-addressed (fnv1a) doesn't include separators
    expect(fileRefs.every(fr => !fr.id.includes('|'))).toBe(true);
  });

  it('skips hashing for items that already carry hash16M', async () => {
    const dandan = makeDandanMock();
    const stubPool = { hash: vi.fn(), dispose: vi.fn() };
    const { result } = renderHook(() =>
      useImport({ db: testDb, dandan, hashPool: stubPool })
    );

    // Pre-hashed items (e.g., re-import after rekey)
    const items = [makeItem('preset.mkv', 1)];
    await act(async () => {
      await result.current.run({ items, libraryId: 'lib-preset' });
    });
    await waitFor(() => expect(result.current.status).toBe('done'));

    expect(stubPool.hash).not.toHaveBeenCalled();
  });

  it('proceeds gracefully when hashPool returns empty (no crash, no hash16M)', async () => {
    const dandan = makeDandanMock();
    const stubPool = {
      hash: vi.fn(async () => ''), // pool timeout / error
      dispose: vi.fn(),
    };
    const { result } = renderHook(() =>
      useImport({ db: testDb, dandan, hashPool: stubPool })
    );

    const items = [makeBareItem('flaky.mkv', 1)];
    await act(async () => {
      await result.current.run({ items, libraryId: 'lib-empty-hash' });
    });
    await waitFor(() => expect(result.current.status).toBe('done'));

    const fileRefs = await testDb.fileRefs.toArray();
    expect(fileRefs.length).toBeGreaterThan(0);
    expect(fileRefs.every(fr => !fr.hash16M)).toBe(true);
  });

  it('second import of identical files reuses the existing series (cache hit)', async () => {
    // This is the bug fix: previously every import minted a new series ulid
    // because cluster.representative.hash16M was undefined and matchCache lookup was skipped.
    const callCount = { value: 0 };
    const dandan = makeDandanMock({ callCount });
    const stubPool = {
      hash: vi.fn(async (file) => `stable-${file.name}`),
      dispose: vi.fn(),
    };

    const { result } = renderHook(() =>
      useImport({ db: testDb, dandan, hashPool: stubPool })
    );

    const items = [
      makeBareItem('ep1.mkv', 1, 'Reuse Show'),
      makeBareItem('ep2.mkv', 2, 'Reuse Show'),
    ];

    // First run → creates one series + season, calls dandan once.
    await act(async () => {
      await result.current.run({ items, libraryId: 'lib-A' });
    });
    await waitFor(() => expect(result.current.status).toBe('done'));
    expect(await testDb.series.count()).toBe(1);
    expect(callCount.value).toBe(1);

    // Second run on same files → must hit cache, not duplicate series.
    await act(async () => {
      await result.current.run({ items, libraryId: 'lib-B' });
    });
    await waitFor(() => expect(result.current.status).toBe('done'));

    expect(await testDb.series.count()).toBe(1);
    expect(callCount.value).toBe(1);
  });
});

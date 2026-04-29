// @ts-check
import 'fake-indexeddb/auto';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { getDb } from '../lib/library/db/db.js';

// ── helpers ────────────────────────────────────────────────────────────────

const NOW = Date.now();

function makeSeries(id = 'S1') {
  return {
    id,
    titleZh: '进击的巨人',
    type: 'tv',
    confidence: 0.9,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeEpisode(id, seriesId, number, primaryFileId) {
  return {
    id,
    seriesId,
    number,
    kind: 'main',
    primaryFileId,
    alternateFileIds: [],
    updatedAt: NOW,
  };
}

function makeFileRef(id, libraryId, relPath) {
  return {
    id,
    libraryId,
    relPath,
    size: 1024,
    mtime: NOW,
    matchStatus: 'matched',
  };
}

/**
 * A fake FileSystemFileHandle that returns a File.
 */
function makeFakeFileHandle(fileName) {
  return {
    kind: 'file',
    name: fileName,
    getFile: vi.fn().mockResolvedValue(new File(['content'], fileName, { type: 'video/mp4' })),
  };
}

/**
 * Build a minimal fileHandles DI shape for useSeriesDetail.
 * selectFileByName(libraryId, relPath) → File|null
 */
function makeFakeFileHandles(impl = null) {
  return {
    selectFileByName: impl ?? vi.fn().mockResolvedValue(null),
  };
}

// ── import hook under test after mocks are set up ──────────────────────────
// We import dynamically so that fake-indexeddb is in effect first.

/**
 * Seed the db with a 1-series + N-episodes setup.
 * Returns { series, episodes, fileRefs }
 */
async function seedDb(db, { episodeCount = 3, libraryId = 'lib-1', seriesId = 'S1' } = {}) {
  const series = makeSeries(seriesId);
  const episodes = Array.from({ length: episodeCount }, (_, i) => {
    const ep = makeEpisode(`ep-${seriesId}-${i + 1}`, seriesId, i + 1, `fr-${seriesId}-${i + 1}`);
    if (i === 0) ep.episodeId = 10001 + i; // dandanplay episode id on first ep
    return ep;
  });
  const fileRefs = episodes.map((ep) =>
    makeFileRef(ep.primaryFileId, libraryId, `Season1/ep${ep.number}.mkv`)
  );

  await db.series.put(series);
  await db.episodes.bulkPut(episodes);
  await db.fileRefs.bulkPut(fileRefs);

  return { series, episodes, fileRefs };
}

import useSeriesDetail from '../hooks/useSeriesDetail.js';

// ── tests ──────────────────────────────────────────────────────────────────

describe('useSeriesDetail (Slice 12)', () => {
  let db;
  let fileHandles;

  beforeEach(async () => {
    db = getDb('test-detail-' + Date.now() + Math.random());
    await db.open();
    fileHandles = makeFakeFileHandles();
  });

  // ─── happy path ───────────────────────────────────────────────────────────

  it('happy: 1 series + 3 episodes → status=ready, episodes.length===3', async () => {
    await seedDb(db, { episodeCount: 3, seriesId: 'S1' });

    const { result } = renderHook(() =>
      useSeriesDetail('S1', { db, fileHandles })
    );

    await waitFor(() => expect(result.current.status).toBe('ready'));

    expect(result.current.series).not.toBeNull();
    expect(result.current.series.id).toBe('S1');
    expect(result.current.episodes).toHaveLength(3);
    expect(result.current.fileRefByEpisode.size).toBe(3);
  });

  it('happy: episodes are sorted ascending by number', async () => {
    const seriesId = 'S-sorted';
    const series = makeSeries(seriesId);
    await db.series.put(series);
    // Insert in reverse order
    await db.episodes.bulkPut([
      makeEpisode('ep-c', seriesId, 3, 'fr-c'),
      makeEpisode('ep-a', seriesId, 1, 'fr-a'),
      makeEpisode('ep-b', seriesId, 2, 'fr-b'),
    ]);
    await db.fileRefs.bulkPut([
      makeFileRef('fr-a', 'lib-1', 'ep1.mkv'),
      makeFileRef('fr-b', 'lib-1', 'ep2.mkv'),
      makeFileRef('fr-c', 'lib-1', 'ep3.mkv'),
    ]);

    const { result } = renderHook(() =>
      useSeriesDetail(seriesId, { db, fileHandles })
    );

    await waitFor(() => expect(result.current.status).toBe('ready'));
    const nums = result.current.episodes.map((e) => e.number);
    expect(nums).toEqual([1, 2, 3]);
  });

  // ─── edge: null seriesId ──────────────────────────────────────────────────

  it('edge: seriesId=null → status=idle, episodes=[]', () => {
    const { result } = renderHook(() =>
      useSeriesDetail(null, { db, fileHandles })
    );

    // Synchronous — should be idle immediately
    expect(result.current.status).toBe('idle');
    expect(result.current.episodes).toEqual([]);
    expect(result.current.series).toBeNull();
    expect(result.current.fileRefByEpisode.size).toBe(0);
  });

  // ─── edge: missing series ────────────────────────────────────────────────

  it('edge: missing series → status=missing', async () => {
    const { result } = renderHook(() =>
      useSeriesDetail('does-not-exist', { db, fileHandles })
    );

    await waitFor(() =>
      expect(['missing', 'error']).toContain(result.current.status)
    );
    expect(result.current.series).toBeNull();
    expect(result.current.episodes).toEqual([]);
  });

  // ─── getFile: success ─────────────────────────────────────────────────────

  it('getFile success: selectFileByName returns File → getFile returns File', async () => {
    const libraryId = 'lib-gf';
    await seedDb(db, { episodeCount: 1, seriesId: 'S-gf', libraryId });

    const fakeFile = new File(['data'], 'ep1.mkv', { type: 'video/mp4' });
    const selectFileByName = vi.fn().mockResolvedValue(fakeFile);
    const fhWithFile = makeFakeFileHandles(selectFileByName);

    const { result } = renderHook(() =>
      useSeriesDetail('S-gf', { db, fileHandles: fhWithFile })
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let file;
    await act(async () => {
      file = await result.current.getFile('ep-S-gf-1');
    });

    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe('ep1.mkv');
    expect(selectFileByName).toHaveBeenCalledWith(libraryId, 'Season1/ep1.mkv');
  });

  // ─── getFile: selectFileByName returns null ───────────────────────────────

  it('getFile failure: selectFileByName returns null → getFile returns null without throwing', async () => {
    await seedDb(db, { episodeCount: 1, seriesId: 'S-null' });

    const fhNull = makeFakeFileHandles(vi.fn().mockResolvedValue(null));

    const { result } = renderHook(() =>
      useSeriesDetail('S-null', { db, fileHandles: fhNull })
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let file = 'sentinel'; // should be overwritten
    await act(async () => {
      file = await result.current.getFile('ep-S-null-1');
    });

    expect(file).toBeNull();
  });

  // ─── getFile: unknown episodeId ───────────────────────────────────────────

  it('getFile unknown episodeId returns null', async () => {
    await seedDb(db, { episodeCount: 1, seriesId: 'S-unk' });

    const { result } = renderHook(() =>
      useSeriesDetail('S-unk', { db, fileHandles })
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let file;
    await act(async () => {
      file = await result.current.getFile('nonexistent-ep-id');
    });
    expect(file).toBeNull();
  });

  // ─── getFile: selectFileByName throws ────────────────────────────────────

  it('getFile wraps throw → returns null without rethrowing', async () => {
    await seedDb(db, { episodeCount: 1, seriesId: 'S-throw' });

    const fhThrow = makeFakeFileHandles(
      vi.fn().mockRejectedValue(new Error('NotAllowedError'))
    );

    const { result } = renderHook(() =>
      useSeriesDetail('S-throw', { db, fileHandles: fhThrow })
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let file;
    await act(async () => {
      file = await result.current.getFile('ep-S-throw-1');
    });
    expect(file).toBeNull();
  });

  // ─── refresh ──────────────────────────────────────────────────────────────

  it('refresh re-loads data after new episodes are added', async () => {
    const seriesId = 'S-refresh';
    await seedDb(db, { episodeCount: 1, seriesId });

    const { result } = renderHook(() =>
      useSeriesDetail(seriesId, { db, fileHandles })
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.episodes).toHaveLength(1);

    // Add a second episode directly to IDB
    await db.episodes.put(makeEpisode('ep-S-refresh-2', seriesId, 2, 'fr-S-refresh-2'));
    await db.fileRefs.put(makeFileRef('fr-S-refresh-2', 'lib-1', 'Season1/ep2.mkv'));

    await act(async () => {
      result.current.refresh();
    });

    await waitFor(() => expect(result.current.episodes).toHaveLength(2));
  });
});

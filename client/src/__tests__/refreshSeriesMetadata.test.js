// @ts-check
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { getDb } from '../lib/library/db/db.js';
import {
  refreshSeriesMetadata,
  refreshAllSeriesMetadata,
} from '../services/refreshSeriesMetadata.js';

/**
 * Build a minimal dandan client mock that returns a fixed enrichment.
 * @param {{ titleZh?: string, titleEn?: string, posterUrl?: string, isMatched?: boolean, animeId?: number }} cfg
 */
function mockDandan(cfg) {
  const enrichment = {};
  if (cfg.titleZh !== undefined) enrichment.titleZh = cfg.titleZh;
  if (cfg.titleEn !== undefined) enrichment.titleEn = cfg.titleEn;
  if (cfg.posterUrl !== undefined) enrichment.posterUrl = cfg.posterUrl;
  return {
    match: vi.fn().mockResolvedValue({
      isMatched: cfg.isMatched !== false,
      animes: [{ animeId: cfg.animeId ?? 12345, animeTitle: 'X' }],
      ...(Object.keys(enrichment).length ? { enrichment } : {}),
    }),
  };
}

describe('refreshSeriesMetadata (single)', () => {
  let db;

  beforeEach(async () => {
    db = getDb('test-refresh-' + Date.now() + Math.random());
    await db.open();

    await db.series.put({
      id: 'sr-1',
      titleZh: '错的标题',
      titleEn: 'Wrong',
      type: 'tv',
      confidence: 0.5,
      createdAt: 0,
      updatedAt: 100,
    });
    await db.episodes.put({
      id: 'ep-1',
      seriesId: 'sr-1',
      number: 1,
      kind: 'main',
      primaryFileId: 'fr-1',
      alternateFileIds: [],
      version: 1,
      updatedAt: 0,
    });
    await db.fileRefs.put({
      id: 'fr-1',
      libraryId: 'lib-1',
      episodeId: 'ep-1',
      relPath: 'folder/Show 01.mkv',
      size: 1024,
      mtime: 0,
      hash16M: 'abc123',
      matchStatus: 'matched',
    });
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

  it('patches series with enrichment when fields differ', async () => {
    const dandan = mockDandan({
      titleZh: '正确标题',
      titleEn: 'Correct',
      posterUrl: 'https://example.com/p.jpg',
    });
    const r = await refreshSeriesMetadata({
      db,
      dandan,
      seriesId: 'sr-1',
      now: () => 5000,
    });
    expect(r.changed).toBe(true);
    expect(r.fields).toEqual(['titleZh', 'titleEn', 'posterUrl']);
    const s = await db.series.get('sr-1');
    expect(s.titleZh).toBe('正确标题');
    expect(s.titleEn).toBe('Correct');
    expect(s.posterUrl).toBe('https://example.com/p.jpg');
    expect(s.updatedAt).toBe(5000);
  });

  it('only updates fields that actually differ', async () => {
    // Pre-set posterUrl matching what dandan will return.
    await db.series.update('sr-1', { posterUrl: 'https://example.com/p.jpg' });
    const dandan = mockDandan({
      titleZh: '正确标题',
      posterUrl: 'https://example.com/p.jpg',
    });
    const r = await refreshSeriesMetadata({
      db,
      dandan,
      seriesId: 'sr-1',
      now: () => 5000,
    });
    expect(r.changed).toBe(true);
    expect(r.fields).toEqual(['titleZh']);
  });

  it('returns unchanged when nothing differs', async () => {
    await db.series.update('sr-1', {
      titleZh: '一样',
      titleEn: 'Same',
      posterUrl: 'https://x.jpg',
    });
    const dandan = mockDandan({
      titleZh: '一样',
      titleEn: 'Same',
      posterUrl: 'https://x.jpg',
    });
    const r = await refreshSeriesMetadata({ db, dandan, seriesId: 'sr-1' });
    expect(r.changed).toBe(false);
    expect(r.skipReason).toBe('unchanged');
  });

  it('skips with no-fileref when series has no episodes', async () => {
    await db.episodes.delete('ep-1');
    const dandan = mockDandan({ titleZh: '新' });
    const r = await refreshSeriesMetadata({ db, dandan, seriesId: 'sr-1' });
    expect(r.changed).toBe(false);
    expect(r.skipReason).toBe('no-fileref');
    expect(dandan.match).not.toHaveBeenCalled();
  });

  it('skips with no-hash when fileRef lacks hash16M', async () => {
    await db.fileRefs.update('fr-1', { hash16M: undefined });
    const dandan = mockDandan({ titleZh: '新' });
    const r = await refreshSeriesMetadata({ db, dandan, seriesId: 'sr-1' });
    expect(r.changed).toBe(false);
    expect(r.skipReason).toBe('no-fileref');
    expect(dandan.match).not.toHaveBeenCalled();
  });

  it('falls back to alternateFileIds when primary lacks hash', async () => {
    await db.fileRefs.put({
      id: 'fr-1',
      libraryId: 'lib-1',
      episodeId: 'ep-1',
      relPath: 'folder/Show 01.mkv',
      size: 1024,
      mtime: 0,
      matchStatus: 'matched',
    });
    await db.fileRefs.put({
      id: 'fr-2',
      libraryId: 'lib-1',
      episodeId: 'ep-1',
      relPath: 'folder/Show 01v2.mkv',
      size: 2048,
      mtime: 0,
      hash16M: 'def456',
      matchStatus: 'matched',
    });
    await db.episodes.update('ep-1', { alternateFileIds: ['fr-2'] });

    const dandan = mockDandan({ titleZh: '新' });
    const r = await refreshSeriesMetadata({ db, dandan, seriesId: 'sr-1' });
    expect(r.changed).toBe(true);
    expect(dandan.match).toHaveBeenCalledWith(
      'def456',
      'Show 01v2.mkv',
      { fileSize: 2048 },
    );
  });

  it('skips with no-match when dandan returns null', async () => {
    const dandan = { match: vi.fn().mockResolvedValue(null) };
    const r = await refreshSeriesMetadata({ db, dandan, seriesId: 'sr-1' });
    expect(r.changed).toBe(false);
    expect(r.skipReason).toBe('no-match');
  });

  it('skips with no-enrichment when dandan returns match without enrichment', async () => {
    const dandan = {
      match: vi.fn().mockResolvedValue({
        isMatched: true,
        animes: [{ animeId: 1, animeTitle: 'X' }],
      }),
    };
    const r = await refreshSeriesMetadata({ db, dandan, seriesId: 'sr-1' });
    expect(r.changed).toBe(false);
    expect(r.skipReason).toBe('no-enrichment');
  });

  it('throws when seriesId is empty', async () => {
    const dandan = mockDandan({ titleZh: 'x' });
    await expect(
      refreshSeriesMetadata({ db, dandan, seriesId: '' }),
    ).rejects.toThrow();
  });

  it('throws when series does not exist', async () => {
    const dandan = mockDandan({ titleZh: 'x' });
    await expect(
      refreshSeriesMetadata({ db, dandan, seriesId: 'nope' }),
    ).rejects.toThrow();
  });

  it('does not overwrite existing field with empty enrichment value', async () => {
    // Empty string in enrichment shouldn't blow away an existing populated field.
    const dandan = {
      match: vi.fn().mockResolvedValue({
        isMatched: true,
        animes: [{ animeId: 1, animeTitle: 'X' }],
        enrichment: { titleZh: '', titleEn: 'Just En' },
      }),
    };
    const r = await refreshSeriesMetadata({ db, dandan, seriesId: 'sr-1' });
    expect(r.fields).toEqual(['titleEn']);
    const s = await db.series.get('sr-1');
    expect(s.titleZh).toBe('错的标题');
    expect(s.titleEn).toBe('Just En');
  });
});

describe('refreshAllSeriesMetadata (bulk)', () => {
  let db;

  beforeEach(async () => {
    db = getDb('test-refresh-bulk-' + Date.now() + Math.random());
    await db.open();

    // Three series, with seedable distinct outcomes:
    //   sr-A → enrichment differs → changed
    //   sr-B → no fileRef → skipped
    //   sr-C → enrichment matches → skipped
    await db.series.bulkPut([
      { id: 'sr-A', titleZh: '旧A', type: 'tv', confidence: 0.5, createdAt: 0, updatedAt: 0 },
      { id: 'sr-B', titleZh: '旧B', type: 'tv', confidence: 0.5, createdAt: 0, updatedAt: 0 },
      { id: 'sr-C', titleZh: '已最新', type: 'tv', confidence: 0.5, createdAt: 0, updatedAt: 0 },
    ]);
    await db.episodes.bulkPut([
      { id: 'ep-A', seriesId: 'sr-A', number: 1, kind: 'main', primaryFileId: 'fr-A', alternateFileIds: [], version: 1, updatedAt: 0 },
      { id: 'ep-C', seriesId: 'sr-C', number: 1, kind: 'main', primaryFileId: 'fr-C', alternateFileIds: [], version: 1, updatedAt: 0 },
    ]);
    await db.fileRefs.bulkPut([
      { id: 'fr-A', libraryId: 'l', episodeId: 'ep-A', relPath: 'A/01.mkv', size: 1, mtime: 0, hash16M: 'h-A', matchStatus: 'matched' },
      { id: 'fr-C', libraryId: 'l', episodeId: 'ep-C', relPath: 'C/01.mkv', size: 1, mtime: 0, hash16M: 'h-C', matchStatus: 'matched' },
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

  it('iterates all series and counts changed/skipped/failed', async () => {
    const dandan = {
      match: vi.fn().mockImplementation(async (hash) => {
        if (hash === 'h-A') {
          return {
            isMatched: true,
            animes: [{ animeId: 1, animeTitle: 'A' }],
            enrichment: { titleZh: '新A' },
          };
        }
        if (hash === 'h-C') {
          return {
            isMatched: true,
            animes: [{ animeId: 3, animeTitle: 'C' }],
            enrichment: { titleZh: '已最新' },
          };
        }
        return null;
      }),
    };
    const summary = await refreshAllSeriesMetadata({ db, dandan });
    expect(summary.total).toBe(3);
    expect(summary.changed).toBe(1);
    expect(summary.skipped).toBe(2);
    expect(summary.failed).toBe(0);
    const a = await db.series.get('sr-A');
    expect(a.titleZh).toBe('新A');
  });

  it('emits onProgress for every series', async () => {
    const dandan = { match: vi.fn().mockResolvedValue(null) };
    const onProgress = vi.fn();
    await refreshAllSeriesMetadata({ db, dandan, onProgress });
    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress.mock.calls[0][0]).toBe(1);
    expect(onProgress.mock.calls[0][1]).toBe(3);
    expect(onProgress.mock.calls[2][0]).toBe(3);
  });

  it('continues past per-series failures and counts them', async () => {
    const dandan = {
      match: vi.fn().mockImplementation(async (hash) => {
        if (hash === 'h-A') throw new Error('boom');
        if (hash === 'h-C') {
          return {
            isMatched: true,
            animes: [{ animeId: 3, animeTitle: 'C' }],
            enrichment: { titleZh: '新C' },
          };
        }
        return null;
      }),
    };
    const summary = await refreshAllSeriesMetadata({ db, dandan });
    expect(summary.failed).toBe(1);
    expect(summary.changed).toBe(1);
    expect(summary.skipped).toBe(1);
    // The failure didn't break the iteration — sr-C still got patched.
    const c = await db.series.get('sr-C');
    expect(c.titleZh).toBe('新C');
  });
});

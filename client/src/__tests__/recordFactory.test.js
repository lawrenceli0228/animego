import { describe, it, expect } from 'vitest';
import {
  buildSeriesRecord,
  buildSeasonRecord,
  buildEpisodeRecord,
  buildFileRefRecord,
  parseVersion,
} from '../lib/library/recordFactory';

/** @typedef {import('../lib/library/types').EpisodeItem} EpisodeItem */
/** @typedef {import('../lib/library/types').MatchCluster} MatchCluster */

/**
 * Minimal EpisodeItem factory.
 * @param {Partial<EpisodeItem>} overrides
 * @returns {EpisodeItem}
 */
function item(overrides = {}) {
  const fileName = overrides.fileName ?? 'ep01.mkv';
  return {
    fileId: overrides.fileId ?? `id:${fileName}`,
    file: null,
    fileName,
    relativePath: overrides.relativePath ?? fileName,
    episode: overrides.episode !== undefined ? overrides.episode : 1,
    parsedKind: overrides.parsedKind ?? 'main',
    parsedTitle: overrides.parsedTitle ?? 'My Anime',
    ...overrides,
  };
}

/**
 * Minimal MatchCluster factory.
 * @param {Partial<MatchCluster>} overrides
 * @returns {MatchCluster}
 */
function cluster(overrides = {}) {
  const representative = overrides.representative ?? item();
  return {
    clusterKey: overrides.clusterKey ?? 'abc12345',
    normalizedTokens: overrides.normalizedTokens ?? ['my', 'anime'],
    groups: overrides.groups ?? [],
    items: overrides.items ?? [representative],
    representative,
    ...overrides,
  };
}

describe('buildSeriesRecord', () => {
  it('produces a stable record given the same ulidSeed', () => {
    const c = cluster();
    const r1 = buildSeriesRecord(c, { confidence: 0.9, ulidSeed: 1000 });
    const r2 = buildSeriesRecord(c, { confidence: 0.9, ulidSeed: 1000 });
    expect(r1.id).toBe(r2.id);
    expect(r1.confidence).toBe(0.9);
  });

  it('uses parsedTitle from representative as titleZh/titleEn', () => {
    const c = cluster({ representative: item({ parsedTitle: 'Attack on Titan' }) });
    const r = buildSeriesRecord(c, { confidence: 0.7, ulidSeed: 42 });
    // titleZh or titleEn should contain the parsed title
    const hasTitle = r.titleZh === 'Attack on Titan' || r.titleEn === 'Attack on Titan';
    expect(hasTitle).toBe(true);
  });

  it('includes createdAt and updatedAt timestamps', () => {
    const r = buildSeriesRecord(cluster(), { confidence: 0.5, ulidSeed: 7 });
    expect(typeof r.createdAt).toBe('number');
    expect(typeof r.updatedAt).toBe('number');
  });

  it('has type field', () => {
    const r = buildSeriesRecord(cluster(), { confidence: 0.5, ulidSeed: 8 });
    expect(['tv', 'movie', 'ova', 'web']).toContain(r.type);
  });
});

describe('buildSeasonRecord', () => {
  it('produces a stable record given the same ulidSeed', () => {
    const s1 = buildSeasonRecord('series-1', 99999, { ulidSeed: 200 });
    const s2 = buildSeasonRecord('series-1', 99999, { ulidSeed: 200 });
    expect(s1.id).toBe(s2.id);
    expect(s1.seriesId).toBe('series-1');
    expect(s1.animeId).toBe(99999);
  });

  it('includes updatedAt', () => {
    const s = buildSeasonRecord('s1', 1, { ulidSeed: 300 });
    expect(typeof s.updatedAt).toBe('number');
  });

  it('defaults season number to 1', () => {
    const s = buildSeasonRecord('s1', 1, { ulidSeed: 400 });
    expect(s.number).toBe(1);
  });
});

describe('buildEpisodeRecord', () => {
  it('produces a stable record given the same ulidSeed', () => {
    const it1 = item({ episode: 1, parsedKind: 'main', fileId: 'f1' });
    const e1 = buildEpisodeRecord({ seriesId: 's1', seasonId: 'ss1', item: it1, ulidSeed: 500 });
    const e2 = buildEpisodeRecord({ seriesId: 's1', seasonId: 'ss1', item: it1, ulidSeed: 500 });
    expect(e1.id).toBe(e2.id);
    expect(e1.seriesId).toBe('s1');
    expect(e1.seasonId).toBe('ss1');
    expect(e1.number).toBe(1);
    expect(e1.kind).toBe('main');
  });

  it('uses item.parsedKind as episode kind', () => {
    const it1 = item({ episode: 2, parsedKind: 'sp', fileId: 'f2' });
    const e = buildEpisodeRecord({ seriesId: 's1', seasonId: null, item: it1, ulidSeed: 501 });
    expect(e.kind).toBe('sp');
    expect(e.number).toBe(2);
  });

  it('sets primaryFileId to the FileRef id (consistent with buildFileRefRecord)', () => {
    // P4-E: Episode.primaryFileId must reference the same id as FileRef.id
    // so cross-table joins work. Previously used soft `name|size|mtime` which
    // never matched FileRef.id (`name|size` or `fnv1a(hash16M+size)`).
    const it1 = item({ fileId: 'unused-soft-id' });
    it1.file = { size: 1234, name: 'ep01.mkv' };
    const e = buildEpisodeRecord({ seriesId: 's1', seasonId: null, item: it1, ulidSeed: 502 });
    const fr = buildFileRefRecord({ libraryId: 'lib1', episodeId: e.id, item: it1 });
    expect(e.primaryFileId).toBe(fr.id);
    expect(e.alternateFileIds).toEqual([]);
  });

  it('primaryFileId becomes content-addressed when item has hash16M', () => {
    const it1 = item({ hash16M: 'cafebabe' });
    it1.file = { size: 5000, name: 'ep01.mkv' };
    const e = buildEpisodeRecord({ seriesId: 's1', seasonId: null, item: it1, ulidSeed: 503 });
    const fr = buildFileRefRecord({ libraryId: 'lib1', episodeId: e.id, item: it1 });
    expect(e.primaryFileId).toBe(fr.id);
    // No pipe — content-addressed hash form
    expect(e.primaryFileId).not.toContain('|');
  });

  // v3.1: Episode.version field
  it('defaults version to 1 for plain episode names', () => {
    const it1 = item({ fileName: '[ANi] Show - 03 [WebRip 1080p].mp4' });
    const e = buildEpisodeRecord({ seriesId: 's1', seasonId: null, item: it1, ulidSeed: 600 });
    expect(e.version).toBe(1);
  });

  it('parses [01v2] revision marker → version 2', () => {
    const it1 = item({ fileName: '[ANi] Show - 01v2 [WebRip 1080p].mp4' });
    const e = buildEpisodeRecord({ seriesId: 's1', seasonId: null, item: it1, ulidSeed: 601 });
    expect(e.version).toBe(2);
  });

  it('parses [03v3] revision marker → version 3', () => {
    const it1 = item({ fileName: '[Group][Show][03v3][1080p].mkv' });
    const e = buildEpisodeRecord({ seriesId: 's1', seasonId: null, item: it1, ulidSeed: 602 });
    expect(e.version).toBe(3);
  });
});

describe('parseVersion', () => {
  it('returns 1 for filenames without a revision marker', () => {
    expect(parseVersion('[Group] Show - 01 [1080p].mkv')).toBe(1);
    expect(parseVersion('Show.E01.1080p.mkv')).toBe(1);
    expect(parseVersion('')).toBe(1);
  });

  it('extracts the revision number after vN', () => {
    expect(parseVersion('[Group] Show - 01v2 [1080p].mkv')).toBe(2);
    expect(parseVersion('[Group][Show][03v3][1080p].mkv')).toBe(3);
    expect(parseVersion('Show.E05v4.WEB-DL.mkv')).toBe(4);
    expect(parseVersion('[01v10].mp4')).toBe(10);
  });

  it('does not false-positive on unrelated v-strings', () => {
    expect(parseVersion('Show.x265.10bit.mkv')).toBe(1);
    expect(parseVersion('vol4.mkv')).toBe(1);
  });
});

describe('buildFileRefRecord', () => {
  it('uses hash(hash16M+size) as id when hash16M is present', () => {
    const it1 = item({ hash16M: 'abc123', fileId: 'f1', file: null });
    // create a minimal File-like object
    it1.file = { size: 1000, name: 'ep01.mkv' };
    const fr = buildFileRefRecord({ libraryId: 'lib1', episodeId: 'ep1', item: it1 });
    expect(typeof fr.id).toBe('string');
    expect(fr.id.length).toBeGreaterThan(0);
    // id should be deterministic
    const fr2 = buildFileRefRecord({ libraryId: 'lib1', episodeId: 'ep1', item: it1 });
    expect(fr.id).toBe(fr2.id);
    // id should NOT be the soft id format
    expect(fr.id).not.toContain('|');
  });

  it('uses soft id (name|size) when hash16M is absent', () => {
    const it1 = item({ hash16M: undefined, fileId: 'f1', fileName: 'ep01.mkv' });
    it1.file = { size: 2000, name: 'ep01.mkv' };
    const fr = buildFileRefRecord({ libraryId: 'lib1', episodeId: 'ep1', item: it1 });
    expect(fr.id).toBe('ep01.mkv|2000');
  });

  it('sets matchStatus to pending', () => {
    const it1 = item();
    it1.file = { size: 100, name: 'ep01.mkv' };
    const fr = buildFileRefRecord({ libraryId: 'lib1', episodeId: null, item: it1 });
    expect(fr.matchStatus).toBe('pending');
  });

  it('copies resolution, group, codec from item', () => {
    const it1 = item({
      parsedResolution: '1080p',
      parsedGroup: 'LoliHouse',
    });
    it1.file = { size: 3000, name: 'ep01.mkv' };
    const fr = buildFileRefRecord({ libraryId: 'lib1', episodeId: null, item: it1 });
    expect(fr.resolution).toBe('1080p');
    expect(fr.group).toBe('LoliHouse');
  });
});

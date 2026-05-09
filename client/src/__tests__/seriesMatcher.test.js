import { describe, it, expect } from 'vitest';
import { matchSingleCluster } from '../lib/library/seriesMatcher';

/** @typedef {import('../lib/library/types').EpisodeItem} EpisodeItem */
/** @typedef {import('../lib/library/types').MatchCluster} MatchCluster */
/** @typedef {import('../lib/library/types').Season} Season */

/**
 * Minimal EpisodeItem factory.
 * @param {Partial<EpisodeItem>} overrides
 * @returns {EpisodeItem}
 */
function item(overrides = {}) {
  const fileName = overrides.fileName ?? 'ep01.mkv';
  return {
    fileId: overrides.fileId ?? `id:${fileName}`,
    file: { size: 1000, name: fileName },
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
    clusterKey: overrides.clusterKey ?? 'testkey',
    normalizedTokens: overrides.normalizedTokens ?? ['my', 'anime'],
    groups: overrides.groups ?? [],
    items: overrides.items ?? [representative],
    representative,
    ...overrides,
  };
}

describe('matchSingleCluster', () => {
  const baseCtx = {
    priorSeasons: [],
    libraryId: 'lib-test',
    ulidSeed: 1000,
  };

  it('returns failed for empty cluster.items', () => {
    const c = cluster({ items: [], representative: null });
    const verdict = matchSingleCluster(c, baseCtx);
    expect(verdict.kind).toBe('failed');
    expect(typeof verdict.reason).toBe('string');
  });

  it('returns reuse when cluster.animeIdHint matches a priorSeason', () => {
    /** @type {Season} */
    const season = {
      id: 'season-abc',
      seriesId: 'series-abc',
      number: 1,
      animeId: 77777,
      updatedAt: Date.now(),
    };
    const c = cluster({ animeIdHint: 77777 });
    const verdict = matchSingleCluster(c, {
      ...baseCtx,
      priorSeasons: [season],
    });
    expect(verdict.kind).toBe('reuse');
    expect(verdict.seriesId).toBe('series-abc');
    expect(verdict.seasonId).toBe('season-abc');
    expect(verdict.animeId).toBe(77777);
  });

  it('returns failed when animeIdHint is set but no matching priorSeason found', () => {
    const c = cluster({ animeIdHint: 99999 });
    // no priorSeasons at all
    const verdict = matchSingleCluster(c, baseCtx);
    // should fall through to 'new' path, not 'reuse'
    expect(verdict.kind).toBe('new');
  });

  it('returns new with confidence 0.9 for cluster with 3+ items having consecutive episode numbers', () => {
    const items = [
      item({ episode: 1, fileId: 'f1', parsedTitle: 'Great Anime' }),
      item({ episode: 2, fileId: 'f2', fileName: 'ep02.mkv', parsedTitle: 'Great Anime' }),
      item({ episode: 3, fileId: 'f3', fileName: 'ep03.mkv', parsedTitle: 'Great Anime' }),
    ];
    const c = cluster({ items, representative: items[0] });
    const verdict = matchSingleCluster(c, baseCtx);
    expect(verdict.kind).toBe('new');
    expect(verdict.confidence).toBe(0.9);
    expect(Array.isArray(verdict.episodeRecords)).toBe(true);
    expect(verdict.episodeRecords?.length).toBe(3);
    expect(Array.isArray(verdict.fileRefRecords)).toBe(true);
    expect(verdict.seriesRecord).toBeDefined();
  });

  it('returns new with confidence 0.5 for single-item cluster', () => {
    const c = cluster({ items: [item({ parsedTitle: 'Lone File' })], representative: item({ parsedTitle: 'Lone File' }) });
    const verdict = matchSingleCluster(c, baseCtx);
    expect(verdict.kind).toBe('new');
    expect(verdict.confidence).toBe(0.5);
  });

  it('returns new with confidence 0.7 for 2-item cluster with parsedTitle but non-consecutive episodes', () => {
    const items = [
      item({ episode: 1, fileId: 'fa', parsedTitle: 'Some Show' }),
      item({ episode: 5, fileId: 'fb', fileName: 'ep05.mkv', parsedTitle: 'Some Show' }),
    ];
    const c = cluster({ items, representative: items[0] });
    const verdict = matchSingleCluster(c, baseCtx);
    expect(verdict.kind).toBe('new');
    expect(verdict.confidence).toBe(0.7);
  });

  it('is deterministic: same ulidSeed produces same seriesRecord id', () => {
    const items = [item({ parsedTitle: 'Stable Anime' })];
    const c = cluster({ items, representative: items[0] });
    const v1 = matchSingleCluster(c, { ...baseCtx, ulidSeed: 9999 });
    const v2 = matchSingleCluster(c, { ...baseCtx, ulidSeed: 9999 });
    expect(v1.seriesRecord?.id).toBe(v2.seriesRecord?.id);
  });
});

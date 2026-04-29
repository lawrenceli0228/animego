import { describe, it, expect } from 'vitest';
import { clusterize } from '../lib/library/clusterizer';

/** @typedef {import('../lib/library/types').EpisodeItem} EpisodeItem */
/** @typedef {import('../lib/library/types').Group} Group */
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
    file: null,
    fileName,
    relativePath: overrides.relativePath ?? fileName,
    episode: overrides.episode !== undefined ? overrides.episode : 1,
    parsedKind: overrides.parsedKind ?? 'main',
    parsedTitle: overrides.parsedTitle,
    ...overrides,
  };
}

/**
 * Minimal Group factory.
 * @param {string} groupKey
 * @param {EpisodeItem[]} items
 * @param {string} [label]
 * @returns {Group}
 */
function group(groupKey, items, label) {
  return {
    id: `g:${groupKey}`,
    groupKey,
    label: label ?? groupKey.split('/').pop() ?? groupKey,
    items,
    sortMode: 'episode',
    hasAmbiguity: false,
  };
}

describe('clusterize', () => {
  it('merges 2 groups with identical parsedTitle into 1 cluster', () => {
    const g1 = group('Show/S1', [item({ parsedTitle: 'Oshi no Ko', episode: 1 })]);
    const g2 = group('Show/S1b', [item({ parsedTitle: 'Oshi no Ko', episode: 2, fileName: 'ep02.mkv' })]);
    const clusters = clusterize([g1, g2]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].groups).toHaveLength(2);
    expect(clusters[0].items).toHaveLength(2);
    expect(clusters[0].normalizedTokens).toContain('oshi');
  });

  it('keeps 2 groups with different parsedTitle as separate clusters', () => {
    const g1 = group('A', [item({ parsedTitle: 'Attack on Titan', episode: 1 })]);
    const g2 = group('B', [item({ parsedTitle: 'Demon Slayer', episode: 1, fileName: 'ep01b.mkv' })]);
    const clusters = clusterize([g1, g2]);
    expect(clusters).toHaveLength(2);
    // Verify groupKey ordering preserved (A before B)
    const keys = clusters.map(c => c.groups[0].groupKey);
    expect(keys).toEqual(['A', 'B']);
  });

  it('creates singleton cluster for group with empty tokens, clusterKey = groupKey', () => {
    // parsedTitle undefined and label is a noise-only string → tokens will be empty
    // Use a group label that normalizes to empty (all noise tokens)
    const noiseLabel = '1080p x264 HEVC AAC';
    const g = {
      id: 'g:SomeFolder',
      groupKey: 'SomeFolder',
      label: noiseLabel,
      items: [item({ parsedTitle: undefined, fileName: '001.mkv', episode: 1 })],
      sortMode: /** @type {'episode'} */ ('episode'),
      hasAmbiguity: false,
    };
    const clusters = clusterize([g]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].clusterKey).toBe('SomeFolder');
    expect(clusters[0].normalizedTokens).toEqual([]);
  });

  it('falls back to group.label when items have no parsedTitle', () => {
    // group with items that have no parsedTitle; label is used for normalization
    const g = group('進撃の巨人', [
      item({ parsedTitle: undefined, episode: 1 }),
    ]);
    const clusters = clusterize([g]);
    // The label '進撃の巨人' normalizes to some CJK tokens — just verify it clusters
    expect(clusters).toHaveLength(1);
  });

  it('picks representative: first main item with episode!=null over others', () => {
    const it1 = item({ parsedTitle: 'My Show', episode: null, parsedKind: 'sp', fileName: 'sp01.mkv', fileId: 'sp01' });
    const it2 = item({ parsedTitle: 'My Show', episode: 1, parsedKind: 'main', fileName: 'ep01.mkv', fileId: 'ep01' });
    const it3 = item({ parsedTitle: 'My Show', episode: 2, parsedKind: 'main', fileName: 'ep02.mkv', fileId: 'ep02' });
    const g1 = group('Show', [it1, it2, it3]);
    const clusters = clusterize([g1]);
    expect(clusters[0].representative?.parsedKind).toBe('main');
    expect(clusters[0].representative?.episode).not.toBeNull();
  });

  it('falls back to first item when no main item with episode!=null', () => {
    const it1 = item({ parsedTitle: 'My Show', episode: null, parsedKind: 'sp', fileName: 'sp01.mkv', fileId: 'sp01' });
    const g1 = group('Show', [it1]);
    const clusters = clusterize([g1]);
    expect(clusters[0].representative?.fileName).toBe('sp01.mkv');
  });

  it('is deterministic: same input twice produces identical clusterKeys', () => {
    const g1 = group('A', [item({ parsedTitle: 'Attack on Titan', episode: 1 })]);
    const g2 = group('B', [item({ parsedTitle: 'Attack on Titan', episode: 2, fileName: 'ep02.mkv' })]);
    const r1 = clusterize([g1, g2]);
    const r2 = clusterize([g1, g2]);
    expect(r1[0].clusterKey).toBe(r2[0].clusterKey);
  });

  it('prefills animeIdHint when priorSeasons title matches cluster', () => {
    /** @type {Season[]} */
    const priorSeasons = [
      {
        id: 'season-1',
        seriesId: 'series-1',
        number: 1,
        animeId: 99999,
        updatedAt: Date.now(),
      },
    ];
    // Give season a matching title via items
    const g1 = group('A', [
      item({ parsedTitle: 'Oshi no Ko', episode: 1 }),
    ]);
    // We need to attach the title to the season — pass in hint via a custom field
    // As per spec: if any group's first item parsedTitle matches priorSeasons normalized title
    // The Season type has no titleZh, so we extend the test to pass _titleHint
    const seasonWithTitle = { ...priorSeasons[0], _titleHint: 'Oshi no Ko' };
    const clusters = clusterize([g1], [seasonWithTitle]);
    expect(clusters[0].animeIdHint).toBe(99999);
  });

  it('does NOT prefill animeIdHint when priorSeasons title does not match', () => {
    const priorSeasons = [
      { id: 's1', seriesId: 'sr1', number: 1, animeId: 12345, updatedAt: 0, _titleHint: 'Demon Slayer' },
    ];
    const g1 = group('A', [item({ parsedTitle: 'Attack on Titan', episode: 1 })]);
    const clusters = clusterize([g1], priorSeasons);
    expect(clusters[0].animeIdHint).toBeUndefined();
  });
});

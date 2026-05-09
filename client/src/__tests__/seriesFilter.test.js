// @ts-check
import { describe, it, expect } from 'vitest';
import { applySeriesFilter } from '../lib/library/seriesFilter.js';

/** @param {Partial<import('../lib/library/types').Series>} o */
function S(o) {
  return {
    id: 'x',
    type: 'tv',
    confidence: 1,
    createdAt: 0,
    updatedAt: 0,
    totalEpisodes: 12,
    ...o,
  };
}

function info({ watched = 0, completed = 0, last = 0 } = {}) {
  return { watchedCount: watched, completedCount: completed, lastPlayedAt: last };
}

describe('applySeriesFilter', () => {
  const series = [
    S({ id: 'A', createdAt: 100, totalEpisodes: 12 }),
    S({ id: 'B', createdAt: 300, totalEpisodes: 12 }),
    S({ id: 'C', createdAt: 200, totalEpisodes: 12 }),
  ];

  it('null filter preserves original order', () => {
    const out = applySeriesFilter(series, new Map(), null);
    expect(out.map((s) => s.id)).toEqual(['A', 'B', 'C']);
  });

  it('"new" sorts by createdAt desc', () => {
    const out = applySeriesFilter(series, new Map(), 'new');
    expect(out.map((s) => s.id)).toEqual(['B', 'C', 'A']);
  });

  it('"recent" filters to series with progress and sorts by lastPlayedAt desc', () => {
    const map = new Map([
      ['A', info({ watched: 1, last: 500 })],
      ['C', info({ watched: 1, last: 1000 })],
    ]);
    const out = applySeriesFilter(series, map, 'recent');
    expect(out.map((s) => s.id)).toEqual(['C', 'A']);
  });

  it('"recent" excludes series with no progress', () => {
    const map = new Map([['A', info({ watched: 1, last: 500 })]]);
    const out = applySeriesFilter(series, map, 'recent');
    expect(out.map((s) => s.id)).toEqual(['A']);
  });

  it('"recent" treats lastPlayedAt=0 as no progress', () => {
    const map = new Map([['A', info({ watched: 1, last: 0 })]]);
    const out = applySeriesFilter(series, map, 'recent');
    expect(out).toEqual([]);
  });

  it('"inProgress" includes series with progress and completed < total', () => {
    const map = new Map([
      ['A', info({ watched: 5, completed: 3 })],
      ['B', info({ watched: 12, completed: 12 })],
      ['C', info({ watched: 0, completed: 0 })],
    ]);
    const out = applySeriesFilter(series, map, 'inProgress');
    expect(out.map((s) => s.id)).toEqual(['A']);
  });

  it('"inProgress" includes series with unknown total but progress', () => {
    const list = [S({ id: 'X', totalEpisodes: undefined })];
    const map = new Map([['X', info({ watched: 2, completed: 0 })]]);
    const out = applySeriesFilter(list, map, 'inProgress');
    expect(out.map((s) => s.id)).toEqual(['X']);
  });

  it('"done" includes only series where completed >= total', () => {
    const map = new Map([
      ['A', info({ watched: 12, completed: 12 })],
      ['B', info({ watched: 5, completed: 5 })],
    ]);
    const out = applySeriesFilter(series, map, 'done');
    expect(out.map((s) => s.id)).toEqual(['A']);
  });

  it('"done" excludes series with totalEpisodes 0 or unknown', () => {
    const list = [
      S({ id: 'X', totalEpisodes: 0 }),
      S({ id: 'Y', totalEpisodes: undefined }),
    ];
    const map = new Map([
      ['X', info({ watched: 1, completed: 1 })],
      ['Y', info({ watched: 1, completed: 1 })],
    ]);
    const out = applySeriesFilter(list, map, 'done');
    expect(out).toEqual([]);
  });
});

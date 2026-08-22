import { describe, expect, test } from 'bun:test';

import {
  applySeriesFilter,
  computeFilterCounts,
  matchesFilter,
} from '../seriesFilter.js';

// Every ratio filter in this module was dead for the entire life of the
// feature: they all read `s.totalEpisodes`, and no line of production code ever
// wrote it. `done`, `almostDone` and `stalled` returned an empty list for every
// library that has ever existed, and `inProgress` / `fresh` quietly degraded to
// "watched at all". The total now arrives as a parameter, because a card can be
// several series soft-merged together and the number these ratios need is the
// whole card's — see `_services/seriesGroups.ts`.

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();

const s = (id) => ({ id, createdAt: 0, updatedAt: 0 });

const prog = (watchedCount, completedCount, lastPlayedAt = NOW) => ({
  watchedCount,
  completedCount,
  lastPlayedAt,
});

const mapOf = (entries) => new Map(Object.entries(entries));

describe('matchesFilter — done', () => {
  test('matches once every episode of the card is completed', () => {
    const pm = mapOf({ A: prog(12, 12) });
    expect(matchesFilter(s('A'), pm, 'done', 12)).toBe(true);
  });

  test('does not match while episodes remain', () => {
    const pm = mapOf({ A: prog(12, 11) });
    expect(matchesFilter(s('A'), pm, 'done', 12)).toBe(false);
  });

  test('an unknown total still means "cannot say", not "done"', () => {
    // The pre-change behaviour for every series in every library. Keeping it is
    // the point: claiming a show is finished because we do not know its length
    // is worse than showing an empty chip.
    const pm = mapOf({ A: prog(12, 12) });
    expect(matchesFilter(s('A'), pm, 'done', 0)).toBe(false);
    expect(matchesFilter(s('A'), pm, 'done', undefined)).toBe(false);
    expect(matchesFilter(s('A'), pm, 'done', -1)).toBe(false);
    expect(matchesFilter(s('A'), pm, 'done', NaN)).toBe(false);
  });

  test('a merged card is done only against the whole card', () => {
    // 12 of 24 watched: done against one season, not done against the pair.
    const pm = mapOf({ A: prog(12, 12) });
    expect(matchesFilter(s('A'), pm, 'done', 12)).toBe(true);
    expect(matchesFilter(s('A'), pm, 'done', 24)).toBe(false);
  });
});

describe('matchesFilter — almostDone', () => {
  test('matches at 80% watched but not yet complete', () => {
    const pm = mapOf({ A: prog(10, 9) });
    expect(matchesFilter(s('A'), pm, 'almostDone', 12)).toBe(true);
  });

  test('does not match below the threshold', () => {
    const pm = mapOf({ A: prog(9, 8) });
    expect(matchesFilter(s('A'), pm, 'almostDone', 12)).toBe(false);
  });

  test('does not match once it is actually done', () => {
    const pm = mapOf({ A: prog(12, 12) });
    expect(matchesFilter(s('A'), pm, 'almostDone', 12)).toBe(false);
  });

  test('an unknown total yields nothing', () => {
    const pm = mapOf({ A: prog(10, 9) });
    expect(matchesFilter(s('A'), pm, 'almostDone', 0)).toBe(false);
    expect(matchesFilter(s('A'), pm, 'almostDone', undefined)).toBe(false);
  });
});

describe('matchesFilter — stalled', () => {
  const stale = NOW - 8 * DAY_MS;

  test('matches mid-progress and untouched for a week', () => {
    const pm = mapOf({ A: prog(6, 6, stale) });
    expect(matchesFilter(s('A'), pm, 'stalled', 12)).toBe(true);
  });

  test('a show watched yesterday is paused, not stuck', () => {
    const pm = mapOf({ A: prog(6, 6, NOW - DAY_MS) });
    expect(matchesFilter(s('A'), pm, 'stalled', 12)).toBe(false);
  });

  test('barely started or nearly finished is not stalled', () => {
    expect(matchesFilter(s('A'), mapOf({ A: prog(1, 1, stale) }), 'stalled', 100)).toBe(
      false,
    );
    expect(matchesFilter(s('A'), mapOf({ A: prog(10, 10, stale) }), 'stalled', 12)).toBe(
      false,
    );
  });

  test('an unknown total yields nothing', () => {
    const pm = mapOf({ A: prog(6, 6, stale) });
    expect(matchesFilter(s('A'), pm, 'stalled', 0)).toBe(false);
    expect(matchesFilter(s('A'), pm, 'stalled', undefined)).toBe(false);
  });
});

describe('matchesFilter — inProgress and fresh degrade safely', () => {
  test('inProgress falls back to "watched at all" without a total', () => {
    const pm = mapOf({ A: prog(3, 3) });
    expect(matchesFilter(s('A'), pm, 'inProgress', undefined)).toBe(true);
  });

  test('inProgress excludes a finished card once the total is known', () => {
    const pm = mapOf({ A: prog(12, 12) });
    expect(matchesFilter(s('A'), pm, 'inProgress', 12)).toBe(false);
    expect(matchesFilter(s('A'), pm, 'inProgress', 24)).toBe(true);
  });

  test('fresh falls back to "watched at all" without a total', () => {
    const pm = mapOf({ A: prog(9, 9) });
    expect(matchesFilter(s('A'), pm, 'fresh', undefined)).toBe(true);
  });

  test('fresh narrows to under 10% once the total is known', () => {
    expect(matchesFilter(s('A'), mapOf({ A: prog(1, 0) }), 'fresh', 24)).toBe(true);
    expect(matchesFilter(s('A'), mapOf({ A: prog(9, 9) }), 'fresh', 24)).toBe(false);
  });

  test('nothing watched matches neither', () => {
    const pm = new Map();
    expect(matchesFilter(s('A'), pm, 'inProgress', 12)).toBe(false);
    expect(matchesFilter(s('A'), pm, 'fresh', 12)).toBe(false);
  });
});

describe('matchesFilter — the total-free filters are untouched', () => {
  test('new matches everything', () => {
    expect(matchesFilter(s('A'), new Map(), 'new', undefined)).toBe(true);
  });

  test('recent needs a play, not a total', () => {
    expect(matchesFilter(s('A'), mapOf({ A: prog(1, 0, NOW) }), 'recent')).toBe(true);
    expect(matchesFilter(s('A'), new Map(), 'recent')).toBe(false);
  });
});

describe('applySeriesFilter', () => {
  const rows = [s('A'), s('B'), s('C')];
  const progressMap = mapOf({
    A: prog(12, 12),
    B: prog(6, 6, NOW - 8 * DAY_MS),
    C: prog(1, 0),
  });
  const totals = new Map([
    ['A', 12],
    ['B', 12],
    ['C', 24],
  ]);

  test('done returns the finished card once totals exist', () => {
    expect(applySeriesFilter(rows, progressMap, 'done', '', totals).map((r) => r.id)).toEqual(
      ['A'],
    );
  });

  test('stalled returns the paused card once totals exist', () => {
    expect(
      applySeriesFilter(rows, progressMap, 'stalled', '', totals).map((r) => r.id),
    ).toEqual(['B']);
  });

  test('omitting the totals map reproduces the old empty result', () => {
    // Not a nicety: this is exactly the shipped behaviour these tests exist to
    // document as a bug rather than a design.
    expect(applySeriesFilter(rows, progressMap, 'done', '')).toEqual([]);
    expect(applySeriesFilter(rows, progressMap, 'stalled', '')).toEqual([]);
  });

  test('a card with no entry in the totals map is treated as unknown', () => {
    const partial = new Map([['B', 12]]);
    expect(
      applySeriesFilter(rows, progressMap, 'done', '', partial).map((r) => r.id),
    ).toEqual([]);
  });

  test('the text query still narrows the filtered set', () => {
    const named = [
      { ...s('A'), titleZh: '药屋少女的呢喃' },
      { ...s('B'), titleEn: 'Frieren' },
    ];
    const pm = mapOf({ A: prog(12, 12), B: prog(12, 12) });
    const t = new Map([
      ['A', 12],
      ['B', 12],
    ]);
    expect(applySeriesFilter(named, pm, 'done', 'frieren', t).map((r) => r.id)).toEqual([
      'B',
    ]);
  });
});

describe('computeFilterCounts', () => {
  test('the ratio chips count zero without totals, and correctly with them', () => {
    const rows = [s('A'), s('B')];
    const progressMap = mapOf({
      A: prog(12, 12),
      B: prog(6, 6, NOW - 8 * DAY_MS),
    });

    const blind = computeFilterCounts(rows, progressMap);
    expect(blind.done).toBe(0);
    expect(blind.stalled).toBe(0);
    expect(blind.almostDone).toBe(0);
    // The degraded pair still reported something, which is why the failure was
    // hard to see: two of the seven chips were lying rather than empty.
    expect(blind.inProgress).toBe(2);

    const sighted = computeFilterCounts(
      rows,
      progressMap,
      new Map([
        ['A', 12],
        ['B', 12],
      ]),
    );
    expect(sighted.done).toBe(1);
    expect(sighted.stalled).toBe(1);
    expect(sighted.inProgress).toBe(1);
    expect(sighted.new).toBe(2);
  });
});

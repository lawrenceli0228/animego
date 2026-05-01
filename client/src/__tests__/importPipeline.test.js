import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getDb } from '../lib/library/db/db.js';
import { runImport } from '../services/importPipeline.js';

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Minimal EpisodeItem factory.
 * @param {string} fileName
 * @param {number} episode
 * @param {string} relativePath
 * @param {string} [parsedTitle]
 * @returns {import('../lib/library/types').EpisodeItem}
 */
function makeItem(fileName, episode, relativePath, parsedTitle = 'Attack on Titan') {
  return {
    fileId: `${fileName}|1000|0`,
    file: { name: fileName, size: 1000, lastModified: 0 },
    fileName,
    relativePath,
    episode,
    parsedKind: 'main',
    parsedTitle,
    hash16M: `fakehash-${fileName}`,
  };
}

/** A dandanplay client mock that returns a matched single result */
function makeDandanMock({ callCount = { value: 0 } } = {}) {
  return {
    async match(hash16M, fileName) {
      callCount.value++;
      return {
        isMatched: true,
        animes: [{
          animeId: 1001,
          animeTitle: 'Attack on Titan S4',
          episodes: [],
        }],
      };
    },
  };
}

/** A dandan mock that returns ambiguous (3 candidates) */
function makeAmbiguousDandanMock() {
  return {
    async match() {
      return {
        isMatched: false,
        animes: [
          { animeId: 101, animeTitle: 'A', episodes: [] },
          { animeId: 102, animeTitle: 'B', episodes: [] },
          { animeId: 103, animeTitle: 'C', episodes: [] },
        ],
      };
    },
  };
}

/** A dandan mock that throws */
function makeThrowingDandanMock() {
  return {
    async match() {
      throw new Error('network error');
    },
  };
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('importPipeline.runImport (Slice 7)', () => {
  let testDb;

  beforeEach(async () => {
    testDb = getDb('test-pipeline-' + Date.now() + Math.random());
    await testDb.open();
  });

  it('happy: 2 clusters (5+3 items) → series rows: 2, matched: 2', async () => {
    const items = [
      // Cluster A: 5 items, folder Show/S1
      ...Array.from({ length: 5 }, (_, i) =>
        makeItem(`aot-ep${i + 1}.mkv`, i + 1, `Show/S1/aot-ep${i + 1}.mkv`, 'Attack on Titan')
      ),
      // Cluster B: 3 items, folder Show/S2 — different parsedTitle
      ...Array.from({ length: 3 }, (_, i) =>
        makeItem(`gits-ep${i + 1}.mkv`, i + 1, `GiTS/gits-ep${i + 1}.mkv`, 'Ghost in the Shell')
      ),
    ];

    const events = [];
    const summary = await runImport(
      { items, libraryId: 'lib1' },
      {
        db: testDb,
        dandan: makeDandanMock(),
        ulidSeedBase: 1,
        onEvent: e => events.push(e),
      }
    );

    expect(summary.clusters).toBe(2);
    expect(summary.matched).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.ambiguous).toBe(0);

    const allSeries = await testDb.series.toArray();
    expect(allSeries).toHaveLength(2);

    // Verify finish event was emitted
    const finishEvent = events.find(e => e.kind === 'finish');
    expect(finishEvent).toBeTruthy();
    expect(finishEvent.summary.matched).toBe(2);
  });

  it('reuse: cluster with matching priorSeason animeId → no new series row', async () => {
    // Pre-seed a series + season
    const existingSeries = {
      id: 'existing-sr',
      titleZh: '既存系列',
      type: 'tv',
      confidence: 1.0,
      createdAt: 1000,
      updatedAt: 1000,
    };
    const existingSeason = {
      id: 'existing-sn',
      seriesId: 'existing-sr',
      number: 1,
      animeId: 1001,
      updatedAt: 1000,
      _titleHint: 'Attack on Titan',
    };
    await testDb.series.put(existingSeries);
    await testDb.seasons.put(existingSeason);

    const items = Array.from({ length: 5 }, (_, i) =>
      makeItem(`aot-ep${i + 1}.mkv`, i + 1, `Show/S1/aot-ep${i + 1}.mkv`, 'Attack on Titan')
    );

    const summary = await runImport(
      { items, libraryId: 'lib1' },
      {
        db: testDb,
        dandan: makeDandanMock(),
        ulidSeedBase: 100,
      }
    );

    // Should reuse, not create a new series
    const allSeries = await testDb.series.toArray();
    expect(allSeries).toHaveLength(1); // only the existing one
    expect(summary.matched).toBe(1);
  });

  it('ambiguous: dandan returns 3 candidates → verdict=ambiguous, episodes NOT persisted, fileRefs written', async () => {
    const items = Array.from({ length: 4 }, (_, i) =>
      makeItem(`unknown-ep${i + 1}.mkv`, i + 1, `Unknown/unknown-ep${i + 1}.mkv`, 'Unknown Show')
    );

    const summary = await runImport(
      { items, libraryId: 'lib1' },
      {
        db: testDb,
        dandan: makeAmbiguousDandanMock(),
      }
    );

    expect(summary.ambiguous).toBe(1);
    expect(summary.matched).toBe(0);

    // Episodes should NOT be persisted
    const episodes = await testDb.episodes.toArray();
    expect(episodes).toHaveLength(0);

    // FileRefs SHOULD be persisted with matchStatus='ambiguous'
    const fileRefs = await testDb.fileRefs.toArray();
    expect(fileRefs.length).toBeGreaterThan(0);
    expect(fileRefs.every(fr => fr.matchStatus === 'ambiguous')).toBe(true);
  });

  it('cache hit: dandan NOT called for cached cluster', async () => {
    const callCount = { value: 0 };
    const dandan = makeDandanMock({ callCount });

    const items = Array.from({ length: 3 }, (_, i) =>
      makeItem(`cached-ep${i + 1}.mkv`, i + 1, `Cached/cached-ep${i + 1}.mkv`, 'Cached Show')
    );

    // Pre-seed the matchCache with the representative's hash
    const representativeHash = `fakehash-cached-ep1.mkv`;
    await testDb.matchCache.put({
      hash16M: representativeHash,
      verdict: { kind: 'new', seriesId: 'cached-sr', animeId: 999 },
      updatedAt: Date.now(),
    });
    // Also seed the actual series + season for reuse path
    await testDb.series.put({
      id: 'cached-sr', titleZh: '缓存系列', type: 'tv', confidence: 1.0,
      createdAt: 1000, updatedAt: 1000,
    });
    await testDb.seasons.put({
      id: 'cached-sn', seriesId: 'cached-sr', number: 1, animeId: 999, updatedAt: 1000,
    });

    await runImport(
      { items, libraryId: 'lib1' },
      { db: testDb, dandan }
    );

    // Dandan should NOT have been called for this cluster
    expect(callCount.value).toBe(0);
  });

  it('cross-folder merge: same parsedTitle in two folders → summary.crossFolderMerges has one entry with both folders', async () => {
    // 5 items in Show/正片/ + 2 items in Show/SPs/ — both share parsedTitle
    // 'Attack on Titan'. Clusterize buckets by normalizedTokens, so they end
    // up in ONE cluster carrying TWO groups. dandan resolves them to a single
    // animeId, the pipeline writes one series, and our seriesFolders tracker
    // records two distinct groupKeys → cross-folder merge entry.
    const items = [
      ...Array.from({ length: 5 }, (_, i) =>
        makeItem(`aot-ep${i + 1}.mkv`, i + 1, `Show/正片/aot-ep${i + 1}.mkv`, 'Attack on Titan')
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        makeItem(`aot-sp${i + 1}.mkv`, 100 + i, `Show/SPs/aot-sp${i + 1}.mkv`, 'Attack on Titan')
      ),
    ];

    const summary = await runImport(
      { items, libraryId: 'lib-merge' },
      { db: testDb, dandan: makeDandanMock(), ulidSeedBase: 1 },
    );

    expect(summary.clusters).toBe(1);
    expect(summary.matched).toBe(1);
    expect(summary.crossFolderMerges).toHaveLength(1);

    const entry = summary.crossFolderMerges[0];
    expect(entry.folders).toHaveLength(2);
    expect(entry.folders).toEqual(['Show/SPs', 'Show/正片']); // sorted asc
    expect(entry.seriesId).toBeTruthy();

    // The seriesId in the entry should be the actual persisted series id
    const allSeries = await testDb.series.toArray();
    expect(allSeries).toHaveLength(1);
    expect(entry.seriesId).toBe(allSeries[0].id);
  });

  it('cross-folder merge: same folder only → no entry', async () => {
    // Sanity check: 5 items in one folder produce no cross-folder merge.
    const items = Array.from({ length: 5 }, (_, i) =>
      makeItem(`aot-ep${i + 1}.mkv`, i + 1, `Show/正片/aot-ep${i + 1}.mkv`, 'Attack on Titan')
    );
    const summary = await runImport(
      { items, libraryId: 'lib-single' },
      { db: testDb, dandan: makeDandanMock(), ulidSeedBase: 1 },
    );
    expect(summary.crossFolderMerges).toHaveLength(0);
  });

  it('cross-folder merge: reuse path also tracked (existing series + new folder)', async () => {
    // Pre-seed a series with one season; then import items from two new
    // folders that resolve via dandan to the same animeId. Both folders
    // attach to the existing series via the reuse verdict.
    await testDb.series.put({
      id: 'sr-existing',
      titleZh: 'Existing AOT',
      type: 'tv',
      confidence: 1,
      createdAt: 0,
      updatedAt: 0,
    });
    await testDb.seasons.put({
      id: 'sn-existing',
      seriesId: 'sr-existing',
      number: 1,
      animeId: 1001,
      updatedAt: 0,
      _titleHint: 'Attack on Titan',
    });

    const items = [
      ...Array.from({ length: 3 }, (_, i) =>
        makeItem(`aot-a${i + 1}.mkv`, i + 1, `New/正片/aot-a${i + 1}.mkv`, 'Attack on Titan')
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        makeItem(`aot-b${i + 1}.mkv`, 100 + i, `New/SPs/aot-b${i + 1}.mkv`, 'Attack on Titan')
      ),
    ];

    const summary = await runImport(
      { items, libraryId: 'lib-reuse' },
      { db: testDb, dandan: makeDandanMock(), ulidSeedBase: 1 },
    );

    expect(summary.clusters).toBe(1);
    expect(summary.matched).toBe(1);
    expect(summary.crossFolderMerges).toHaveLength(1);
    expect(summary.crossFolderMerges[0].seriesId).toBe('sr-existing');
    expect(summary.crossFolderMerges[0].folders).toEqual(['New/SPs', 'New/正片']);

    // Still exactly one series — no duplicate created.
    const allSeries = await testDb.series.toArray();
    expect(allSeries).toHaveLength(1);
  });

  it('error isolation: dandan throws on cluster A → emits failed, cluster B still completes', async () => {
    const items = [
      // Cluster A (will throw)
      ...Array.from({ length: 3 }, (_, i) =>
        makeItem(`throw-ep${i + 1}.mkv`, i + 1, `ThrowCluster/throw-ep${i + 1}.mkv`, 'Throw Show')
      ),
      // Cluster B (will succeed)
      ...Array.from({ length: 3 }, (_, i) =>
        makeItem(`ok-ep${i + 1}.mkv`, i + 1, `OkCluster/ok-ep${i + 1}.mkv`, 'OK Show')
      ),
    ];

    const events = [];
    // dandan throws for "Throw Show", succeeds for "OK Show"
    const mixedDandan = {
      async match(hash16M, fileName) {
        if (fileName.startsWith('throw')) throw new Error('dandan error');
        return { isMatched: true, animes: [{ animeId: 555, animeTitle: 'OK Show', episodes: [] }] };
      },
    };

    const summary = await runImport(
      { items, libraryId: 'lib1' },
      { db: testDb, dandan: mixedDandan, onEvent: e => events.push(e) }
    );

    expect(summary.failed).toBeGreaterThanOrEqual(1);
    expect(summary.matched).toBeGreaterThanOrEqual(1);

    const failedEvents = events.filter(e => e.kind === 'clusterDone' && e.verdict === 'failed');
    expect(failedEvents.length).toBeGreaterThanOrEqual(1);

    const matchedEvents = events.filter(e => e.kind === 'clusterDone' && e.verdict === 'matched');
    expect(matchedEvents.length).toBeGreaterThanOrEqual(1);
  });
});

// ── P4-F-3: userOverride routing ───────────────────────────────────────────

describe('importPipeline + userOverride (P4-F-3)', () => {
  let testDb;

  beforeEach(async () => {
    testDb = getDb('test-pipeline-override-' + Date.now() + Math.random());
    await testDb.open();
  });

  it('overrideSeasonAnimeId reroutes a reuse verdict to the override season', async () => {
    // Series with two seasons; the user has decided animeId 1002 is the right one.
    await testDb.series.put({
      id: 'sr-multi',
      titleZh: '复数 season',
      type: 'tv',
      confidence: 1,
      createdAt: 0,
      updatedAt: 0,
    });
    await testDb.seasons.bulkPut([
      { id: 'sn-1001', seriesId: 'sr-multi', number: 1, animeId: 1001, updatedAt: 0, _titleHint: 'Attack on Titan' },
      { id: 'sn-1002', seriesId: 'sr-multi', number: 2, animeId: 1002, updatedAt: 0, _titleHint: 'Attack on Titan' },
    ]);
    // matchCache says hash → animeId 1001 (the "wrong" one)
    await testDb.matchCache.put({
      hash16M: 'fakehash-aot-ep1.mkv',
      verdict: { kind: 'new', seriesId: 'sr-multi', animeId: 1001 },
      updatedAt: 0,
    });
    // User has overridden series → animeId 1002
    await testDb.userOverride.put({
      seriesId: 'sr-multi',
      overrideSeasonAnimeId: 1002,
      updatedAt: 1,
    });

    const items = [makeItem('aot-ep1.mkv', 1, 'Show/aot-ep1.mkv', 'Attack on Titan')];
    const callCount = { value: 0 };
    await runImport(
      { items, libraryId: 'lib-override' },
      { db: testDb, dandan: makeDandanMock({ callCount }) },
    );

    // dandan must NOT be called — cache short-circuits
    expect(callCount.value).toBe(0);
    // The matchCache should now reflect the override animeId, not the original
    const updatedCache = await testDb.matchCache.get('fakehash-aot-ep1.mkv');
    expect(updatedCache?.verdict?.animeId).toBe(1002);
  });

  it('override with no overrideSeasonAnimeId is a no-op (locked alone does not reroute)', async () => {
    await testDb.series.put({
      id: 'sr-locked',
      titleZh: 'lock only',
      type: 'tv',
      confidence: 1,
      createdAt: 0,
      updatedAt: 0,
    });
    await testDb.seasons.put({
      id: 'sn-locked',
      seriesId: 'sr-locked',
      number: 1,
      animeId: 1001,
      updatedAt: 0,
      _titleHint: 'Attack on Titan',
    });
    await testDb.matchCache.put({
      hash16M: 'fakehash-aot-ep1.mkv',
      verdict: { kind: 'new', seriesId: 'sr-locked', animeId: 1001 },
      updatedAt: 0,
    });
    await testDb.userOverride.put({
      seriesId: 'sr-locked',
      locked: true,
      updatedAt: 1,
    });

    const items = [makeItem('aot-ep1.mkv', 1, 'Show/aot-ep1.mkv', 'Attack on Titan')];
    await runImport(
      { items, libraryId: 'lib-locked' },
      { db: testDb, dandan: makeDandanMock() },
    );

    // animeId stays 1001
    const cached = await testDb.matchCache.get('fakehash-aot-ep1.mkv');
    expect(cached?.verdict?.animeId).toBe(1001);
    // Still exactly one season under sr-locked
    const seasons = await testDb.seasons.where('seriesId').equals('sr-locked').toArray();
    expect(seasons).toHaveLength(1);
  });

  it('overrideSeasonAnimeId with no matching season is a no-op (no auto-creation)', async () => {
    // Override points to an animeId that does NOT exist in priorSeasons. The
    // pipeline must not silently fabricate a season — it should fall through
    // to the matcher's verdict so the user notices the missing target.
    await testDb.series.put({
      id: 'sr-nomatch',
      titleZh: 'unmatched override',
      type: 'tv',
      confidence: 1,
      createdAt: 0,
      updatedAt: 0,
    });
    await testDb.seasons.put({
      id: 'sn-real',
      seriesId: 'sr-nomatch',
      number: 1,
      animeId: 1001,
      updatedAt: 0,
      _titleHint: 'Attack on Titan',
    });
    await testDb.matchCache.put({
      hash16M: 'fakehash-aot-ep1.mkv',
      verdict: { kind: 'new', seriesId: 'sr-nomatch', animeId: 1001 },
      updatedAt: 0,
    });
    await testDb.userOverride.put({
      seriesId: 'sr-nomatch',
      overrideSeasonAnimeId: 9999,
      updatedAt: 1,
    });

    const items = [makeItem('aot-ep1.mkv', 1, 'Show/aot-ep1.mkv', 'Attack on Titan')];
    await runImport(
      { items, libraryId: 'lib-nomatch' },
      { db: testDb, dandan: makeDandanMock() },
    );

    const cached = await testDb.matchCache.get('fakehash-aot-ep1.mkv');
    expect(cached?.verdict?.animeId).toBe(1001);
    const seasons = await testDb.seasons.where('seriesId').equals('sr-nomatch').toArray();
    expect(seasons).toHaveLength(1);
  });
});

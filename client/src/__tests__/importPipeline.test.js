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

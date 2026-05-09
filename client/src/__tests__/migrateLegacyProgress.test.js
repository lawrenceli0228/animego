import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../lib/library/db/db.js';
import { migrateLegacyProgress, LEGACY_KEY_RE } from '../lib/library/db/migrateLegacyProgress.js';

/**
 * Make a minimal in-memory localStorage stand-in for tests.
 */
function makeMemStorage(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    get length() { return store.size; },
    key(i) { return Array.from(store.keys())[i] ?? null; },
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    clear() { store.clear(); },
    _dump: () => Object.fromEntries(store),
  };
}

async function seedSeriesAndEpisode(db, { seriesId, animeId, epNum, episodeId }) {
  await db.series.put({
    id: seriesId,
    titleZh: 'Test',
    type: 'tv',
    confidence: 1,
    createdAt: 1,
    updatedAt: 1,
  });
  const seasonId = `${seriesId}:s1`;
  await db.seasons.put({ id: seasonId, seriesId, number: 1, animeId, updatedAt: 1 });
  await db.episodes.put({
    id: episodeId,
    seriesId,
    seasonId,
    number: epNum,
    kind: 'main',
    primaryFileId: 'fake',
    alternateFileIds: [],
    version: 1,
    updatedAt: 1,
  });
}

describe('migrateLegacyProgress (P4-C)', () => {
  let testDb;

  beforeEach(async () => {
    testDb = getDb('test-migrate-' + Date.now() + Math.random());
    await testDb.open();
  });

  it('LEGACY_KEY_RE matches `animego:progress:<id>:<ep>` and only that', () => {
    expect('animego:progress:42:5'.match(LEGACY_KEY_RE)).toBeTruthy();
    expect('animego:progress:9999:01'.match(LEGACY_KEY_RE)).toBeTruthy();
    expect('animego:progress:abc:1'.match(LEGACY_KEY_RE)).toBeFalsy();
    expect('animego:heatmapConfig'.match(LEGACY_KEY_RE)).toBeFalsy();
    expect('foo'.match(LEGACY_KEY_RE)).toBeFalsy();
  });

  it('migrates one matching key into the progress table and removes the legacy key', async () => {
    await seedSeriesAndEpisode(testDb, {
      seriesId: 'sr-1',
      animeId: 42,
      epNum: 5,
      episodeId: 'ep-mig-1',
    });

    const storage = makeMemStorage({
      'animego:progress:42:5': JSON.stringify({ t: 320, savedAt: 9_000 }),
      'unrelated.key': 'leave-me-alone',
    });

    const summary = await migrateLegacyProgress({ db: testDb, storage, now: () => 10_000 });

    expect(summary).toMatchObject({ total: 1, migrated: 1, failed: 0 });

    const row = await testDb.progress.get('ep-mig-1');
    expect(row).toMatchObject({
      episodeId: 'ep-mig-1',
      seriesId: 'sr-1',
      positionSec: 320,
      updatedAt: 9_000,
    });

    expect(storage.getItem('animego:progress:42:5')).toBeNull();
    expect(storage.getItem('unrelated.key')).toBe('leave-me-alone');
  });

  it('writes durationSec=0 sentinel since legacy format never recorded duration', async () => {
    await seedSeriesAndEpisode(testDb, { seriesId: 'sr-1', animeId: 7, epNum: 3, episodeId: 'ep-d0' });
    const storage = makeMemStorage({
      'animego:progress:7:3': JSON.stringify({ t: 60, savedAt: 1 }),
    });
    await migrateLegacyProgress({ db: testDb, storage });
    const row = await testDb.progress.get('ep-d0');
    expect(row.durationSec).toBe(0);
  });

  it('records a migrationFailure when no matching season/episode is found, and keeps the legacy key', async () => {
    const storage = makeMemStorage({
      'animego:progress:99999:1': JSON.stringify({ t: 100, savedAt: 8_000 }),
    });

    const summary = await migrateLegacyProgress({
      db: testDb,
      storage,
      now: () => 10_000,
    });

    expect(summary).toMatchObject({ total: 1, migrated: 0, failed: 1 });

    const fail = await testDb.migrationFailures.get('animego:progress:99999:1');
    expect(fail).toMatchObject({
      key: 'animego:progress:99999:1',
      attemptedAt: 10_000,
      attempts: 1,
    });
    expect(fail.reason).toMatch(/no.*match/i);

    // Legacy key preserved so a future import + retry can rescue it.
    expect(storage.getItem('animego:progress:99999:1')).not.toBeNull();
  });

  it('skips and records a failure for malformed JSON values', async () => {
    await seedSeriesAndEpisode(testDb, { seriesId: 'sr-1', animeId: 1, epNum: 1, episodeId: 'ok' });
    const storage = makeMemStorage({
      'animego:progress:1:1': '{not valid json',
    });

    const summary = await migrateLegacyProgress({ db: testDb, storage });
    expect(summary.failed).toBe(1);
    const fail = await testDb.migrationFailures.get('animego:progress:1:1');
    expect(fail.reason).toMatch(/parse/i);
  });

  it('skips and records a failure when t is missing or non-numeric', async () => {
    await seedSeriesAndEpisode(testDb, { seriesId: 'sr-1', animeId: 1, epNum: 1, episodeId: 'ok' });
    const storage = makeMemStorage({
      'animego:progress:1:1': JSON.stringify({ savedAt: 1 }),
    });

    const summary = await migrateLegacyProgress({ db: testDb, storage });
    expect(summary.failed).toBe(1);
    const fail = await testDb.migrationFailures.get('animego:progress:1:1');
    expect(fail.reason).toMatch(/t/);
  });

  it('is idempotent — running twice does not double-write or double-remove', async () => {
    await seedSeriesAndEpisode(testDb, { seriesId: 'sr-1', animeId: 42, epNum: 5, episodeId: 'ep-mig' });
    const storage = makeMemStorage({
      'animego:progress:42:5': JSON.stringify({ t: 320, savedAt: 9_000 }),
    });

    const a = await migrateLegacyProgress({ db: testDb, storage });
    const b = await migrateLegacyProgress({ db: testDb, storage });

    expect(a.migrated).toBe(1);
    expect(b.total).toBe(0); // nothing left to do
    expect(b.migrated).toBe(0);

    const row = await testDb.progress.get('ep-mig');
    expect(row.positionSec).toBe(320);
  });

  it('on retry of a previously failed key, increments attempts and updates attemptedAt', async () => {
    const storage = makeMemStorage({
      'animego:progress:99999:1': JSON.stringify({ t: 100, savedAt: 1 }),
    });

    await migrateLegacyProgress({ db: testDb, storage, now: () => 1_000 });
    await migrateLegacyProgress({ db: testDb, storage, now: () => 2_000 });

    const fail = await testDb.migrationFailures.get('animego:progress:99999:1');
    expect(fail.attempts).toBe(2);
    expect(fail.attemptedAt).toBe(2_000);
  });

  it('handles a mix of match / no-match / malformed in one pass', async () => {
    await seedSeriesAndEpisode(testDb, { seriesId: 'sr-1', animeId: 11, epNum: 2, episodeId: 'good' });
    const storage = makeMemStorage({
      'animego:progress:11:2': JSON.stringify({ t: 50, savedAt: 1 }),
      'animego:progress:404:1': JSON.stringify({ t: 50, savedAt: 1 }),
      'animego:progress:11:99': '{bad',
      'unrelated': '1',
    });

    const summary = await migrateLegacyProgress({ db: testDb, storage });
    expect(summary).toMatchObject({ total: 3, migrated: 1, failed: 2 });
  });

  it('returns zero summary when storage has no legacy keys', async () => {
    const storage = makeMemStorage({ unrelated: 'x' });
    const summary = await migrateLegacyProgress({ db: testDb, storage });
    expect(summary).toEqual({ total: 0, migrated: 0, failed: 0 });
  });
});

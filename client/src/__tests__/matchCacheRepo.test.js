import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../lib/library/db/db.js';
import { makeMatchCacheRepo, MAX_ENTRIES, DEFAULT_TTL_MS } from '../lib/library/db/matchCacheRepo.js';

describe('matchCacheRepo (Slice 6)', () => {
  let testDb;

  beforeEach(async () => {
    testDb = getDb('test-mcache-' + Date.now() + Math.random());
    await testDb.open();
  });

  it('put then get returns the stored verdict', async () => {
    let t = 1_000_000;
    const repo = makeMatchCacheRepo(testDb, { now: () => t });
    const verdict = { kind: 'new', seriesId: 'sr1' };
    await repo.put('abc123', verdict);
    const result = await repo.get('abc123');
    expect(result).toMatchObject(verdict);
  });

  it('get returns null for a missing hash', async () => {
    const repo = makeMatchCacheRepo(testDb);
    const result = await repo.get('nonexistent');
    expect(result).toBeNull();
  });

  it('get returns null when entry is expired (past TTL)', async () => {
    let t = 1_000_000;
    const repo = makeMatchCacheRepo(testDb, { now: () => t });
    await repo.put('expiring', { kind: 'reuse' });

    // Advance beyond default TTL (7 days + 1ms)
    t = 1_000_000 + DEFAULT_TTL_MS + 1;
    const result = await repo.get('expiring');
    expect(result).toBeNull();
  });

  it('get returns verdict when entry is within TTL', async () => {
    let t = 1_000_000;
    const repo = makeMatchCacheRepo(testDb, { now: () => t });
    await repo.put('fresh', { kind: 'reuse', animeId: 7 });

    // Advance less than TTL
    t = 1_000_000 + DEFAULT_TTL_MS - 1000;
    const result = await repo.get('fresh');
    expect(result).not.toBeNull();
    expect(result.animeId).toBe(7);
  });

  it('LRU eviction: after putting MAX_ENTRIES+1 entries, count is MAX_ENTRIES', async () => {
    let t = 1_000_000;
    const repo = makeMatchCacheRepo(testDb, { now: () => t });
    const total = MAX_ENTRIES + 1;
    for (let i = 0; i < total; i++) {
      t = 1_000_000 + i;
      await repo.put(`hash${i}`, { kind: 'new', i });
    }
    const count = await testDb.matchCache.count();
    expect(count).toBe(MAX_ENTRIES);
  }, 30_000);

  it('LRU eviction drops the oldest entry (lowest updatedAt)', async () => {
    let t = 2_000_000;
    const repo = makeMatchCacheRepo(testDb, { now: () => t });

    // Insert MAX_ENTRIES entries with known times
    for (let i = 0; i < MAX_ENTRIES; i++) {
      t = 2_000_000 + i * 10;
      await repo.put(`evict-hash${i}`, { kind: 'new', seq: i });
    }

    // The oldest is evict-hash0 (smallest updatedAt = 2_000_000)
    const oldest = await testDb.matchCache.get('evict-hash0');
    expect(oldest).not.toBeUndefined(); // still present before overflow

    // Add one more — should evict evict-hash0
    t = 2_000_000 + MAX_ENTRIES * 10;
    await repo.put('evict-overflow', { kind: 'new' });

    const evicted = await testDb.matchCache.get('evict-hash0');
    expect(evicted).toBeUndefined();

    const newEntry = await testDb.matchCache.get('evict-overflow');
    expect(newEntry).not.toBeUndefined();
  }, 30_000);
});

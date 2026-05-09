import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db, getDb } from '../lib/library/db/db.js';

describe('Dexie schema (Slice 4)', () => {
  afterEach(async () => {
    // Close each db opened by getDb during the test
  });

  it('opens successfully and exposes 11 named stores (v5 adds progress / userOverride / migrationFailures)', async () => {
    await db.open();
    const storeNames = db.tables.map(t => t.name).sort();
    expect(storeNames).toEqual([
      'episodes',
      'fileHandles',
      'fileRefs',
      'libraries',
      'matchCache',
      'migrationFailures',
      'opsLog',
      'progress',
      'seasons',
      'series',
      'userOverride',
    ]);
  });

  it('re-open returns the same instance (singleton)', async () => {
    const a = getDb('animego-library');
    const b = getDb('animego-library');
    expect(a).toBe(b);
  });

  it('getDb with different names returns distinct instances', async () => {
    const d1 = getDb('test-schema-1');
    const d2 = getDb('test-schema-2');
    expect(d1).not.toBe(d2);
    await d1.open();
    await d2.open();
  });

  it('supports basic put/get round-trip on series table', async () => {
    const testDb = getDb('test-schema-rtrip-' + Date.now());
    await testDb.open();
    const record = {
      id: 'test-id-1',
      titleZh: '进击的巨人',
      type: 'tv',
      confidence: 0.9,
      createdAt: 1000,
      updatedAt: 2000,
    };
    await testDb.series.put(record);
    const fetched = await testDb.series.get('test-id-1');
    expect(fetched).toMatchObject({ id: 'test-id-1', titleZh: '进击的巨人' });
    await testDb.close();
    testDb.delete();
  });
});

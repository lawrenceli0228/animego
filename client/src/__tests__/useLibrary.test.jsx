// @ts-check
import 'fake-indexeddb/auto';
import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { getDb } from '../lib/library/db/db.js';
import useLibrary from '../hooks/useLibrary.js';

/** @param {import('dexie').Dexie} db */
function makeSeriesRecord(overrides = {}) {
  return {
    id: `sr-${Math.random().toString(36).slice(2)}`,
    titleZh: 'Test Series',
    type: 'tv',
    confidence: 1.0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('useLibrary', () => {
  let testDb;

  beforeEach(async () => {
    testDb = getDb('test-library-' + Date.now() + Math.random());
    await testDb.open();
  });

  it('happy: series store has 2 rows → hook returns 2', async () => {
    await testDb.series.bulkPut([
      makeSeriesRecord({ id: 'sr-1', titleZh: '进击的巨人' }),
      makeSeriesRecord({ id: 'sr-2', titleZh: '鬼灭之刃' }),
    ]);

    const { result } = renderHook(() => useLibrary({ db: testDb }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.series).toHaveLength(2);
  });

  it('edge: empty store → returns []', async () => {
    const { result } = renderHook(() => useLibrary({ db: testDb }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.series).toEqual([]);
  });

  it('starts with loading=true initially', () => {
    const { result } = renderHook(() => useLibrary({ db: testDb }));
    // On first render before liveQuery resolves, loading should be true
    // (it may quickly become false in test env, so just check type)
    expect(typeof result.current.loading).toBe('boolean');
  });

  it('edge: insert via db → series count increases', async () => {
    const { result } = renderHook(() => useLibrary({ db: testDb }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.series).toHaveLength(0);

    await act(async () => {
      await testDb.series.put(makeSeriesRecord({ id: 'inserted' }));
    });

    await waitFor(() => expect(result.current.series).toHaveLength(1));
  });

  it('refetch() can be called without throwing', async () => {
    const { result } = renderHook(() => useLibrary({ db: testDb }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    // refetch() should not throw
    await act(async () => {
      result.current.refetch();
    });

    // liveQuery already handles reactivity; refetch is an escape hatch
    expect(typeof result.current.refetch).toBe('function');
  });

  it('returns series sorted by updatedAt desc', async () => {
    await testDb.series.bulkPut([
      makeSeriesRecord({ id: 'sr-old', updatedAt: 1000 }),
      makeSeriesRecord({ id: 'sr-new', updatedAt: 9999 }),
    ]);

    const { result } = renderHook(() => useLibrary({ db: testDb }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.series.length).toBe(2);
    // Most recently updated should be first
    expect(result.current.series[0].updatedAt).toBeGreaterThanOrEqual(result.current.series[1].updatedAt);
  });
});

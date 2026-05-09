// @ts-check
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { getDb } from '../lib/library/db/db.js';
import useUserOverride from '../hooks/useUserOverride.js';

describe('useUserOverride', () => {
  let testDb;

  beforeEach(async () => {
    testDb = getDb('test-userOverride-hook-' + Date.now() + Math.random());
    await testDb.open();
  });

  it('starts with empty Map and loading=true', async () => {
    const { result } = renderHook(() => useUserOverride({ db: testDb }));
    expect(result.current.all).toBeInstanceOf(Map);
    // After the first liveQuery emit, loading flips false even when empty.
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.all.size).toBe(0);
  });

  it('reflects existing overrides on mount', async () => {
    await testDb.userOverride.put({
      seriesId: 'sr-pre-existing',
      locked: true,
      updatedAt: 1000,
    });
    const { result } = renderHook(() => useUserOverride({ db: testDb }));
    await waitFor(() => expect(result.current.all.size).toBe(1));
    expect(result.current.all.get('sr-pre-existing')?.locked).toBe(true);
  });

  it('lock(seriesId) writes locked:true and reflects in `all`', async () => {
    const { result } = renderHook(() => useUserOverride({ db: testDb }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.lock('sr-lock-1');
    });

    await waitFor(() =>
      expect(result.current.all.get('sr-lock-1')?.locked).toBe(true),
    );
  });

  it('lock(seriesId, animeId) also stores overrideSeasonAnimeId', async () => {
    const { result } = renderHook(() => useUserOverride({ db: testDb }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.lock('sr-lock-2', 12345);
    });

    await waitFor(() => {
      const o = result.current.all.get('sr-lock-2');
      expect(o?.locked).toBe(true);
      expect(o?.overrideSeasonAnimeId).toBe(12345);
    });
  });

  it('unlock(seriesId) sets locked:false but keeps the row', async () => {
    const { result } = renderHook(() => useUserOverride({ db: testDb }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.lock('sr-unlock', 99);
    });
    await waitFor(() => expect(result.current.all.get('sr-unlock')?.locked).toBe(true));

    await act(async () => {
      await result.current.unlock('sr-unlock');
    });
    await waitFor(() => {
      const o = result.current.all.get('sr-unlock');
      expect(o?.locked).toBe(false);
      // unlock keeps overrideSeasonAnimeId so users don't lose the picked animeId
      expect(o?.overrideSeasonAnimeId).toBe(99);
    });
  });

  it('clear(seriesId) deletes the row', async () => {
    const { result } = renderHook(() => useUserOverride({ db: testDb }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.lock('sr-clear');
    });
    await waitFor(() => expect(result.current.all.has('sr-clear')).toBe(true));

    await act(async () => {
      await result.current.clear('sr-clear');
    });
    await waitFor(() => expect(result.current.all.has('sr-clear')).toBe(false));
  });

  it('update(seriesId, partial) merges fields without clobbering siblings', async () => {
    const { result } = renderHook(() => useUserOverride({ db: testDb }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.lock('sr-update', 555);
    });
    await act(async () => {
      await result.current.update('sr-update', { mergedFrom: ['sr-x', 'sr-y'] });
    });

    await waitFor(() => {
      const o = result.current.all.get('sr-update');
      expect(o?.locked).toBe(true);
      expect(o?.overrideSeasonAnimeId).toBe(555);
      expect(o?.mergedFrom).toEqual(['sr-x', 'sr-y']);
    });
  });
});

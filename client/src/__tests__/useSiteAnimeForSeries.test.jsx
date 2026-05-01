// @ts-check
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const mockSearchAnime = vi.fn();
vi.mock('../api/dandanplay.api', () => ({
  searchAnime: (kw) => mockSearchAnime(kw),
}));

import useSiteAnimeForSeries from '../hooks/useSiteAnimeForSeries.js';

function makeSeries(over = {}) {
  return {
    id: 's-' + Math.random().toString(36).slice(2),
    titleZh: '进击的巨人',
    titleEn: 'Attack on Titan',
    type: 'tv',
    confidence: 0.9,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

beforeEach(() => {
  mockSearchAnime.mockReset();
});

describe('useSiteAnimeForSeries', () => {
  it('returns null while a series has no title at all', async () => {
    const series = makeSeries({ titleZh: '', titleEn: '', titleJa: '' });
    const { result } = renderHook(() => useSiteAnimeForSeries({ series }));
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(mockSearchAnime).not.toHaveBeenCalled();
  });

  it('returns null when series is null', () => {
    const { result } = renderHook(() => useSiteAnimeForSeries({ series: null }));
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(mockSearchAnime).not.toHaveBeenCalled();
  });

  it('flips loading=true while fetching, then resolves with siteAnime data', async () => {
    let resolveFn;
    mockSearchAnime.mockImplementationOnce(() => new Promise((resolve) => { resolveFn = resolve; }));
    const series = makeSeries();
    const { result } = renderHook(() => useSiteAnimeForSeries({ series }));
    // Loading flips true synchronously after the effect runs
    await waitFor(() => expect(result.current.loading).toBe(true));
    expect(result.current.data).toBeNull();
    // Resolve the network call
    resolveFn({ results: [{ source: 'animeCache', anilistId: 7, titleChinese: '进击的巨人' }] });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.anilistId).toBe(7);
  });

  it('picks the exact-title match when one is available', async () => {
    mockSearchAnime.mockResolvedValueOnce({
      results: [
        { source: 'animeCache', anilistId: 1, titleChinese: '别的番剧', averageScore: 50 },
        { source: 'animeCache', anilistId: 2, titleChinese: '进击的巨人', averageScore: 88, format: 'TV' },
        { source: 'dandanplay', dandanAnimeId: 3, title: '进击的巨人' },
      ],
    });
    const series = makeSeries();
    const { result } = renderHook(() =>
      useSiteAnimeForSeries({ series }),
    );
    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.data.anilistId).toBe(2);
    expect(result.current.data.averageScore).toBe(88);
    expect(result.current.data.format).toBe('TV');
    expect(result.current.loading).toBe(false);
  });

  it('falls back to first animeCache hit when nothing scores', async () => {
    mockSearchAnime.mockResolvedValueOnce({
      results: [
        { source: 'animeCache', anilistId: 1, titleChinese: '完全不沾边的番' },
        { source: 'dandanplay', dandanAnimeId: 9, title: '别的' },
      ],
    });
    const series = makeSeries();
    const { result } = renderHook(() =>
      useSiteAnimeForSeries({ series }),
    );
    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.data.anilistId).toBe(1);
  });

  it('returns null when no animeCache hits are returned', async () => {
    mockSearchAnime.mockResolvedValueOnce({
      results: [
        { source: 'dandanplay', dandanAnimeId: 9, title: 'whatever' },
      ],
    });
    const series = makeSeries();
    const { result } = renderHook(() =>
      useSiteAnimeForSeries({ series }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeNull();
  });

  it('swallows network errors and returns null', async () => {
    mockSearchAnime.mockRejectedValueOnce(new Error('boom'));
    const series = makeSeries();
    const { result } = renderHook(() =>
      useSiteAnimeForSeries({ series }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeNull();
  });

  it('caches by series id — second hook on the same id skips the network call', async () => {
    mockSearchAnime.mockResolvedValue({
      results: [{ source: 'animeCache', anilistId: 7, titleChinese: '进击的巨人' }],
    });
    const series = makeSeries();
    const first = renderHook(() => useSiteAnimeForSeries({ series }));
    await waitFor(() => expect(first.result.current.data?.anilistId).toBe(7));
    expect(mockSearchAnime).toHaveBeenCalledTimes(1);

    // Render a second hook with the same series — must NOT trigger another fetch.
    const second = renderHook(() => useSiteAnimeForSeries({ series }));
    await waitFor(() => expect(second.result.current.data?.anilistId).toBe(7));
    expect(mockSearchAnime).toHaveBeenCalledTimes(1);
    // And the cached path resolves with loading=false immediately.
    expect(second.result.current.loading).toBe(false);
  });
});

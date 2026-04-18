import { renderHook, act, waitFor } from '@testing-library/react';
import useDandanMatch from '../hooks/useDandanMatch';

const mockMatchAnime = vi.fn();
const mockGetEpisodes = vi.fn();

vi.mock('../api/dandanplay.api', () => ({
  matchAnime: (...args) => mockMatchAnime(...args),
  getEpisodes: (...args) => mockGetEpisodes(...args),
}));

beforeEach(() => {
  mockMatchAnime.mockReset();
  mockGetEpisodes.mockReset();
});

describe('useDandanMatch — initial state', () => {
  it('starts in idle phase with pending step statuses', () => {
    const { result } = renderHook(() => useDandanMatch());
    expect(result.current.phase).toBe('idle');
    expect(result.current.step).toBe(0);
    expect(result.current.stepStatus).toEqual({ 1: 'pending', 2: 'pending', 3: 'pending' });
    expect(result.current.matchResult).toBeNull();
    expect(result.current.error).toBeNull();
  });
});

describe('useDandanMatch.startMatch', () => {
  it('transitions to ready when match succeeds', async () => {
    const matched = { matched: true, anime: { anilistId: 1 }, episodeMap: { 1: {} } };
    mockMatchAnime.mockResolvedValue(matched);

    const { result } = renderHook(() => useDandanMatch());
    await act(async () => {
      await result.current.startMatch('Show', [1], 'Show - 01.mkv', [{ fileName: 'Show - 01.mkv' }]);
    });

    expect(result.current.phase).toBe('ready');
    expect(result.current.matchResult).toEqual(matched);
    expect(result.current.stepStatus).toEqual({ 1: 'done', 2: 'done', 3: 'done' });
  });

  it('transitions to manual when match fails cleanly', async () => {
    mockMatchAnime.mockResolvedValue({ matched: false });

    const { result } = renderHook(() => useDandanMatch());
    await act(async () => {
      await result.current.startMatch('Show', [1], 'Show - 01.mkv', []);
    });

    expect(result.current.phase).toBe('manual');
    expect(result.current.stepStatus[2]).toBe('fail');
    expect(result.current.stepStatus[3]).toBe('fail');
  });

  it('transitions to error on unexpected exception (non-401)', async () => {
    mockMatchAnime.mockRejectedValue(new Error('network down'));

    const { result } = renderHook(() => useDandanMatch());
    await act(async () => {
      await result.current.startMatch('Show', [1], 'Show - 01.mkv', []);
    });

    expect(result.current.phase).toBe('error');
    expect(result.current.error).toBe('network down');
  });

  it('swallows 401 errors (handled globally) without transitioning to error', async () => {
    mockMatchAnime.mockRejectedValue({ response: { status: 401 } });

    const { result } = renderHook(() => useDandanMatch());
    await act(async () => {
      await result.current.startMatch('Show', [1], 'Show - 01.mkv', []);
    });

    expect(result.current.phase).toBe('matching');
    expect(result.current.error).toBeNull();
  });

  it('sends fileHash/fileSize when getFilesHashes resolves with hash data', async () => {
    mockMatchAnime.mockResolvedValue({ matched: true, anime: {}, episodeMap: {} });
    const getHashes = vi.fn().mockResolvedValue([
      { fileName: 'a.mkv', fileHash: 'abc123', fileSize: 1024 },
    ]);

    const { result } = renderHook(() => useDandanMatch());
    await act(async () => {
      await result.current.startMatch('Show', [1], 'a.mkv', [{ fileName: 'a.mkv' }], getHashes);
    });

    expect(getHashes).toHaveBeenCalled();
    expect(mockMatchAnime).toHaveBeenCalledWith(
      expect.objectContaining({ fileHash: 'abc123', fileSize: 1024 })
    );
  });

  it('falls back to basicFiles when getFilesHashes times out', async () => {
    vi.useFakeTimers();
    mockMatchAnime.mockResolvedValue({ matched: true, anime: {}, episodeMap: {} });
    const getHashes = vi.fn(() => new Promise(() => {})); // never resolves
    const basicFiles = [{ fileName: 'a.mkv' }];

    const { result } = renderHook(() => useDandanMatch());
    const runPromise = act(async () => {
      const p = result.current.startMatch('Show', [1], 'a.mkv', basicFiles, getHashes);
      // Advance past the 10s timeout
      await vi.advanceTimersByTimeAsync(10000);
      await p;
    });
    await runPromise;

    expect(mockMatchAnime).toHaveBeenCalledWith(
      expect.objectContaining({ files: basicFiles })
    );
    // Should not include fileHash since no hash data was produced
    expect(mockMatchAnime.mock.calls[0][0].fileHash).toBeUndefined();
    vi.useRealTimers();
  });
});

describe('useDandanMatch.selectManual', () => {
  it('fetches episodes via bgmId when provided', async () => {
    mockGetEpisodes.mockResolvedValue({
      episodes: [
        { number: 1, dandanEpisodeId: 111, title: 'Ep 1' },
        { number: 2, dandanEpisodeId: 222, title: 'Ep 2' },
      ],
    });

    const { result } = renderHook(() => useDandanMatch());
    await act(async () => {
      await result.current.selectManual(
        { bgmId: 999, anilistId: 42, title: 'Show', titleChinese: '节目' },
        [1, 2]
      );
    });

    expect(mockGetEpisodes).toHaveBeenCalledWith(0, 999);
    expect(result.current.phase).toBe('ready');
    expect(result.current.matchResult.episodeMap).toEqual({
      1: { dandanEpisodeId: 111, title: 'Ep 1' },
      2: { dandanEpisodeId: 222, title: 'Ep 2' },
    });
    expect(result.current.matchResult.siteAnime.anilistId).toBe(42);
  });

  it('uses dandanAnimeId when bgmId is absent', async () => {
    mockGetEpisodes.mockResolvedValue({
      episodes: [{ number: 1, dandanEpisodeId: 1, title: 'A' }],
    });

    const { result } = renderHook(() => useDandanMatch());
    await act(async () => {
      await result.current.selectManual({ dandanAnimeId: 555, title: 'Show' }, [1]);
    });

    expect(mockGetEpisodes).toHaveBeenCalledWith(555);
    expect(result.current.phase).toBe('ready');
  });

  it('leaves siteAnime null when no anilistId on chosen anime', async () => {
    mockGetEpisodes.mockResolvedValue({ episodes: [] });

    const { result } = renderHook(() => useDandanMatch());
    await act(async () => {
      await result.current.selectManual({ dandanAnimeId: 1, title: 'Show' }, []);
    });

    expect(result.current.matchResult.siteAnime).toBeNull();
  });

  it('sets error phase when episode fetch fails', async () => {
    mockGetEpisodes.mockRejectedValue(new Error('boom'));

    const { result } = renderHook(() => useDandanMatch());
    await act(async () => {
      await result.current.selectManual({ dandanAnimeId: 1, title: 'Show' }, [1]);
    });

    expect(result.current.phase).toBe('error');
    expect(result.current.error).toBe('boom');
  });
});

describe('useDandanMatch.reset', () => {
  it('returns to initial state', async () => {
    mockMatchAnime.mockResolvedValue({ matched: true, anime: {}, episodeMap: {} });

    const { result } = renderHook(() => useDandanMatch());
    await act(async () => {
      await result.current.startMatch('Show', [1], 'a.mkv', []);
    });
    expect(result.current.phase).toBe('ready');

    act(() => { result.current.reset(); });
    expect(result.current.phase).toBe('idle');
    expect(result.current.matchResult).toBeNull();
    expect(result.current.step).toBe(0);
  });
});

describe('useDandanMatch.updateEpisodeMap', () => {
  it('merges a new episode entry into episodeMap', async () => {
    mockMatchAnime.mockResolvedValue({
      matched: true,
      anime: { anilistId: 1, titleNative: 'Show' },
      episodeMap: { 1: { title: 'One' } },
    });

    const { result } = renderHook(() => useDandanMatch());
    await act(async () => {
      await result.current.startMatch('Show', [1], 'a.mkv', []);
    });

    act(() => {
      result.current.updateEpisodeMap(2, { dandanEpisodeId: 2, title: 'Two' });
    });

    expect(result.current.matchResult.episodeMap).toEqual({
      1: { title: 'One' },
      2: { dandanEpisodeId: 2, title: 'Two' },
    });
  });

  it('merges newAnime metadata while preserving existing fields', async () => {
    mockMatchAnime.mockResolvedValue({
      matched: true,
      anime: { anilistId: 1, titleNative: 'Old', titleRomaji: 'OldRom' },
      episodeMap: {},
    });

    const { result } = renderHook(() => useDandanMatch());
    await act(async () => {
      await result.current.startMatch('Show', [], 'a.mkv', []);
    });

    act(() => {
      result.current.updateEpisodeMap(1, { title: 'T' }, {
        dandanAnimeId: 777,
        titleChinese: '中文名',
      });
    });

    expect(result.current.matchResult.anime.dandanAnimeId).toBe(777);
    expect(result.current.matchResult.anime.titleChinese).toBe('中文名');
    // Preserved
    expect(result.current.matchResult.anime.anilistId).toBe(1);
    expect(result.current.matchResult.anime.titleRomaji).toBe('OldRom');
  });

  it('is a no-op when matchResult is null', () => {
    const { result } = renderHook(() => useDandanMatch());
    act(() => { result.current.updateEpisodeMap(1, { title: 'T' }); });
    expect(result.current.matchResult).toBeNull();
  });
});

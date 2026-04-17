import { renderHook, act, waitFor } from '@testing-library/react';
import useDandanComments from '../hooks/useDandanComments';

const mockGetComments = vi.fn();

vi.mock('../api/dandanplay.api', () => ({
  getComments: (...args) => mockGetComments(...args),
}));

describe('useDandanComments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads comments and converts them on success', async () => {
    mockGetComments.mockResolvedValue({
      count: 2,
      comments: [
        { cid: 1, p: '10.5,1,16777215', m: 'hello' },
        { cid: 2, p: '20.0,1,16777215', m: 'world' },
      ],
    });

    const { result } = renderHook(() => useDandanComments());

    await act(async () => {
      await result.current.loadComments(123);
    });

    expect(result.current.count).toBe(2);
    expect(result.current.danmakuList).toHaveLength(2);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('silently ignores 401 without surfacing an error', async () => {
    // axios 401 shape
    const err = new Error('Request failed with status code 401');
    err.response = { status: 401 };
    mockGetComments.mockRejectedValue(err);

    const { result } = renderHook(() => useDandanComments());

    await act(async () => {
      await result.current.loadComments(123);
    });

    expect(result.current.error).toBeNull();
    expect(result.current.danmakuList).toEqual([]);
    expect(result.current.count).toBe(0);
    expect(result.current.loading).toBe(false);
  });

  it('surfaces non-401 errors', async () => {
    const err = new Error('network boom');
    err.response = { status: 500 };
    mockGetComments.mockRejectedValue(err);

    const { result } = renderHook(() => useDandanComments());

    await act(async () => {
      await result.current.loadComments(123);
    });

    expect(result.current.error).toBe('network boom');
    expect(result.current.danmakuList).toEqual([]);
    expect(result.current.count).toBe(0);
  });

  it('does not setState after unmount', async () => {
    let resolveFn;
    mockGetComments.mockReturnValue(new Promise(resolve => { resolveFn = resolve; }));

    const { result, unmount } = renderHook(() => useDandanComments());

    act(() => {
      result.current.loadComments(123);
    });

    unmount();

    // Resolve after unmount — should be a no-op, not an act() warning
    await act(async () => {
      resolveFn({ count: 5, comments: [] });
      await Promise.resolve();
    });

    // No assertion on state (hook is unmounted). Test passes if no act() warning fires.
  });

  it('clearComments resets state', () => {
    const { result } = renderHook(() => useDandanComments());

    act(() => {
      result.current.clearComments();
    });

    expect(result.current.danmakuList).toEqual([]);
    expect(result.current.count).toBe(0);
    expect(result.current.error).toBeNull();
  });

  it('does nothing when episodeId is falsy', async () => {
    const { result } = renderHook(() => useDandanComments());

    await act(async () => {
      await result.current.loadComments(null);
    });

    expect(mockGetComments).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
  });
});

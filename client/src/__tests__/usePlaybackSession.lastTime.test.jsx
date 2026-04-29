/**
 * TDD — P2 session-resume: lastTime Map
 *
 * Tests for the new getLastTime / setLastTime / resumeAt surface added to
 * usePlaybackSession.  Run RED first, implement GREEN, verify coverage.
 */
import { renderHook, act } from '@testing-library/react';
import { vi } from 'vitest';
import usePlaybackSession from '../hooks/usePlaybackSession';

// ─── Browser API stubs (jsdom lacks these) ────────────────────────────────────
let urlSeq = 0;
const createObjectURL = vi.fn(() => `blob:mock-lt-${++urlSeq}`);
const revokeObjectURL = vi.fn();

beforeAll(() => {
  global.URL.createObjectURL = createObjectURL;
  global.URL.revokeObjectURL = revokeObjectURL;
});

afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  urlSeq = 0;
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  vi.resetModules();
});

// ─── Mock resolveSubtitle (tests #8 / invariant #9 need controlled mkv task) ─
vi.mock('../utils/resolveSubtitle', () => ({
  resolveSubtitle: vi.fn(),
}));

import { resolveSubtitle as mockResolveSubtitle } from '../utils/resolveSubtitle';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDeps(overrides = {}) {
  return {
    getVideoUrl: vi.fn((f) => `blob:video-${f.name}`),
    getSubtitleUrl: vi.fn((f) => `blob:sub-${f.name}`),
    loadComments: vi.fn(),
    clearComments: vi.fn(),
    ...overrides,
  };
}

/**
 * Build a minimal EpisodeItem with a fileId.
 * fileId format mirrors EpisodeItem: `name|size|lastModified`.
 */
function makeItem(name, episode = 1, fileIdOverride = null) {
  const file = new File(['x'], name, { type: 'video/mp4' });
  const fileId = fileIdOverride ?? `${name}|1|0`;
  return { fileName: name, file, episode, fileId, subtitle: null };
}

/** Default resolveSubtitle stub: return { kind: 'none' } — no subtitle. */
function stubSubtitleNone() {
  mockResolveSubtitle.mockReturnValue({ kind: 'none' });
}

/** Stub resolveSubtitle to return a controllable mkv task. */
function stubSubtitleMkv() {
  const cancel = vi.fn();
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  mockResolveSubtitle.mockReturnValue({ kind: 'mkv', task: { promise, cancel } });
  return { cancel, resolve };
}

// ─── Test suite ──────────────────────────────────────────────────────────────

describe('usePlaybackSession — getLastTime / setLastTime / resumeAt (P2)', () => {
  // ── Test 1: getLastTime returns null for unknown id ──────────────────────
  it('1. getLastTime(unknownId) returns null, not undefined', () => {
    stubSubtitleNone();
    const { result } = renderHook(() => usePlaybackSession(makeDeps()));

    const val = result.current.getLastTime('does-not-exist');
    expect(val).toBeNull();
    expect(val).not.toBeUndefined();
  });

  // ── Test 2: setLastTime / getLastTime round-trip with rounding ───────────
  it('2. setLastTime(id, 12.7) stores 13; getLastTime returns 13', () => {
    stubSubtitleNone();
    const { result } = renderHook(() => usePlaybackSession(makeDeps()));

    act(() => { result.current.setLastTime('ep-a', 12.7); });
    expect(result.current.getLastTime('ep-a')).toBe(13);
  });

  it('2b. setLastTime(id, 12.3) rounds down to 12', () => {
    stubSubtitleNone();
    const { result } = renderHook(() => usePlaybackSession(makeDeps()));

    act(() => { result.current.setLastTime('ep-b', 12.3); });
    expect(result.current.getLastTime('ep-b')).toBe(12);
  });

  // ── Test 3: setLastTime ignores falsy / negative / NaN / empty id ────────
  it('3a. setLastTime ignores sec=0 — Map remains empty', () => {
    stubSubtitleNone();
    const { result } = renderHook(() => usePlaybackSession(makeDeps()));

    act(() => { result.current.setLastTime('ep-c', 0); });
    expect(result.current.getLastTime('ep-c')).toBeNull();
  });

  it('3b. setLastTime ignores negative sec — no mutation', () => {
    stubSubtitleNone();
    const { result } = renderHook(() => usePlaybackSession(makeDeps()));

    act(() => { result.current.setLastTime('ep-d', -5); });
    expect(result.current.getLastTime('ep-d')).toBeNull();
  });

  it('3c. setLastTime ignores NaN — no mutation', () => {
    stubSubtitleNone();
    const { result } = renderHook(() => usePlaybackSession(makeDeps()));

    act(() => { result.current.setLastTime('ep-e', NaN); });
    expect(result.current.getLastTime('ep-e')).toBeNull();
  });

  it('3d. setLastTime ignores empty episodeId — no mutation', () => {
    stubSubtitleNone();
    const { result } = renderHook(() => usePlaybackSession(makeDeps()));

    act(() => { result.current.setLastTime('', 30); });
    // getLastTime('') should also return null
    expect(result.current.getLastTime('')).toBeNull();
  });

  // ── Test 4: play() with prior lastTime exposes resumeAt ─────────────────
  it('4. play(fileItem) with stored lastTime → resumeAt equals stored seconds', () => {
    stubSubtitleNone();
    const { result } = renderHook(() => usePlaybackSession(makeDeps()));
    const item = makeItem('Show - 01.mp4', 1);

    act(() => { result.current.setLastTime(item.fileId, 60.6); });
    act(() => { result.current.play(item, {}); });

    expect(result.current.resumeAt).toBe(61); // 60.6 rounds to 61
  });

  // ── Test 5: play() with no prior lastTime → resumeAt is null ────────────
  it('5. play(fileItem) with no prior lastTime → resumeAt === null', () => {
    stubSubtitleNone();
    const { result } = renderHook(() => usePlaybackSession(makeDeps()));
    const item = makeItem('Show - 02.mp4', 2);

    act(() => { result.current.play(item, {}); });

    expect(result.current.resumeAt).toBeNull();
  });

  // ── Test 6: back() does NOT clear the Map ────────────────────────────────
  it('6. back() preserves lastTime Map — resume survives back→play', () => {
    stubSubtitleNone();
    const { result } = renderHook(() => usePlaybackSession(makeDeps()));
    const item = makeItem('Show - 03.mp4', 3);

    act(() => { result.current.setLastTime(item.fileId, 45); });
    act(() => { result.current.back(); });
    // After back(), phase is none but Map is intact
    expect(result.current.phase).toBe('none');
    expect(result.current.getLastTime(item.fileId)).toBe(45);

    // Re-play same file — resumeAt should be 45
    stubSubtitleNone(); // reset stub for second play
    act(() => { result.current.play(item, {}); });
    expect(result.current.resumeAt).toBe(45);
  });

  // ── Test 7: switching episodes — correct resumeAt per fileId ────────────
  it('7. play(a)→setLastTime(a)→play(b)→play(a) → resumeAt=stored a value', () => {
    stubSubtitleNone();
    const deps = makeDeps();
    const { result } = renderHook(() => usePlaybackSession(deps));
    const itemA = makeItem('Show - 01.mp4', 1, 'a|100|0');
    const itemB = makeItem('Show - 02.mp4', 2, 'b|100|0');

    // Play A, store progress, play B, then play A again
    act(() => { result.current.play(itemA, {}); });
    act(() => { result.current.setLastTime(itemA.fileId, 60); });

    stubSubtitleNone();
    act(() => { result.current.play(itemB, {}); });
    // B has no stored time
    expect(result.current.resumeAt).toBeNull();

    stubSubtitleNone();
    act(() => { result.current.play(itemA, {}); });
    // A's stored time is 60
    expect(result.current.resumeAt).toBe(60);
  });

  // ── Test 8: two distinct fileIds with same episode number ────────────────
  it('8. two distinct fileIds with same episode number store independently', () => {
    stubSubtitleNone();
    const { result } = renderHook(() => usePlaybackSession(makeDeps()));
    // Different files that happen to have the same episode number
    const itemHD = makeItem('Show - 01.1080p.mp4', 1, 'hd|2000000|100');
    const itemSD = makeItem('Show - 01.720p.mp4', 1, 'sd|1000000|100');

    act(() => { result.current.setLastTime(itemHD.fileId, 120); });
    act(() => { result.current.setLastTime(itemSD.fileId, 50); });

    expect(result.current.getLastTime(itemHD.fileId)).toBe(120);
    expect(result.current.getLastTime(itemSD.fileId)).toBe(50);

    // Play HD — resumeAt 120; play SD — resumeAt 50
    stubSubtitleNone();
    act(() => { result.current.play(itemHD, {}); });
    expect(result.current.resumeAt).toBe(120);

    stubSubtitleNone();
    act(() => { result.current.play(itemSD, {}); });
    expect(result.current.resumeAt).toBe(50);
  });

  // ── Test 9: invariant #6 — switching play() cancels prior subtitle task ──
  it('9. invariant #6: switching play() cancels the prior pending mkv subtitle task', () => {
    const { cancel: cancel1 } = stubSubtitleMkv();
    const deps = makeDeps();
    const { result } = renderHook(() => usePlaybackSession(deps));
    const itemA = makeItem('Show - 01.mkv', 1, 'a|100|0');

    act(() => { result.current.play(itemA, {}); });
    // First task registered — cancel not yet called
    expect(cancel1).not.toHaveBeenCalled();

    // Switch to next episode — this should cancel task 1
    const itemB = makeItem('Show - 02.mkv', 2, 'b|100|0');
    stubSubtitleMkv(); // stub for the second play call
    act(() => { result.current.play(itemB, {}); });

    expect(cancel1).toHaveBeenCalledTimes(1);
  });
});

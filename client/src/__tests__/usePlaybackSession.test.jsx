import { renderHook, act } from '@testing-library/react';
import usePlaybackSession from '../hooks/usePlaybackSession';

// jsdom lacks URL.createObjectURL / revokeObjectURL
let urlSeq = 0;
const createObjectURL = vi.fn(() => `blob:mock-${++urlSeq}`);
const revokeObjectURL = vi.fn();

// Worker mock — captures instances so tests can drive responses manually
class MockWorker {
  constructor(url, opts) {
    this.url = url;
    this.opts = opts;
    this.terminated = false;
    this.posted = [];
    this.onmessage = null;
    this.onerror = null;
    MockWorker.instances.push(this);
  }
  postMessage(msg) { this.posted.push(msg); }
  terminate() { this.terminated = true; }
  __respond(data) { if (this.onmessage) this.onmessage({ data }); }
  __error(err) { if (this.onerror) this.onerror(err); }
}
MockWorker.instances = [];

beforeAll(() => {
  global.URL.createObjectURL = createObjectURL;
  global.URL.revokeObjectURL = revokeObjectURL;
  vi.stubGlobal('Worker', MockWorker);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  urlSeq = 0;
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  MockWorker.instances = [];
});

function makeFile(name) {
  return new File(['x'], name, { type: 'video/x-matroska' });
}

function makeFileItem(name, episode = 1, subtitle = null) {
  return {
    fileName: name,
    file: makeFile(name),
    episode,
    subtitle,
  };
}

function makeDeps(overrides = {}) {
  return {
    getVideoUrl: vi.fn((f) => `blob:video-${f.name}`),
    getSubtitleUrl: vi.fn((f) => `blob:sub-${f.name}`),
    loadComments: vi.fn(),
    clearComments: vi.fn(),
    ...overrides,
  };
}

describe('usePlaybackSession — initial state', () => {
  it('starts in none phase with all session fields null', () => {
    const { result } = renderHook(() => usePlaybackSession(makeDeps()));
    expect(result.current.phase).toBe('none');
    expect(result.current.playingFile).toBeNull();
    expect(result.current.playingEp).toBeNull();
    expect(result.current.videoUrl).toBeNull();
    expect(result.current.subtitleUrl).toBeNull();
  });
});

describe('usePlaybackSession — invariant #1: blob lifecycle', () => {
  it('play() then back() revokes the mkv subtitle blob', async () => {
    const deps = makeDeps();
    const { result } = renderHook(() => usePlaybackSession(deps));

    act(() => {
      result.current.play(makeFileItem('Show - 01.mkv'), { 1: { dandanEpisodeId: 100 } });
    });
    expect(result.current.phase).toBe('playing');
    expect(MockWorker.instances).toHaveLength(1);

    // Worker resolves with VTT — blob created (async: promise chain in hook)
    await act(async () => {
      MockWorker.instances[0].__respond({
        result: { type: 'vtt', content: 'WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nhi\n' },
      });
    });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(result.current.subtitleUrl).toBe('blob:mock-1');

    // Back to list — blob must be revoked
    act(() => { result.current.back(); });
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-1');
    expect(result.current.phase).toBe('none');
    expect(result.current.subtitleUrl).toBeNull();
    expect(deps.clearComments).toHaveBeenCalled();
  });
});

describe('usePlaybackSession — invariant #6: stale worker isolation', () => {
  it('switching episodes terminates the pending mkv worker and ignores its late response', async () => {
    const deps = makeDeps();
    const { result } = renderHook(() => usePlaybackSession(deps));
    const epMap = { 1: { dandanEpisodeId: 100 }, 2: { dandanEpisodeId: 200 } };

    act(() => { result.current.play(makeFileItem('Show - 01.mkv', 1), epMap); });
    expect(MockWorker.instances).toHaveLength(1);
    const stale = MockWorker.instances[0];

    // Switch before stale responds
    act(() => { result.current.play(makeFileItem('Show - 02.mkv', 2), epMap); });
    expect(stale.terminated).toBe(true);
    expect(MockWorker.instances).toHaveLength(2);

    // Late response from stale worker MUST NOT pollute current subtitle.
    // Defensive nullify makes __respond a no-op since onmessage was cleared.
    await act(async () => {
      stale.__respond({
        result: { type: 'vtt', content: 'WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nSTALE\n' },
      });
    });
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(result.current.subtitleUrl).toBeNull();
    expect(result.current.playingEp).toBe(2);
  });
});

describe('usePlaybackSession — unmount cleanup', () => {
  it('unmount terminates pending worker and revokes any blob held', async () => {
    const deps = makeDeps();
    const { result, unmount } = renderHook(() => usePlaybackSession(deps));

    act(() => { result.current.play(makeFileItem('Show - 01.mkv'), { 1: {} }); });
    await act(async () => {
      MockWorker.instances[0].__respond({
        result: { type: 'vtt', content: 'WEBVTT\n\n' },
      });
    });
    expect(createObjectURL).toHaveBeenCalledTimes(1);

    // Start a second play — first blob revoked at play() entry, second worker pending
    act(() => { result.current.play(makeFileItem('Show - 02.mkv', 2), { 2: {} }); });
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-1');
    const pendingWorker = MockWorker.instances[1];
    expect(pendingWorker.terminated).toBe(false);

    unmount();
    expect(pendingWorker.terminated).toBe(true);
  });
});

describe('usePlaybackSession — external subtitle short-circuit', () => {
  it('does not spawn an mkv worker when external subtitle is attached', () => {
    const deps = makeDeps();
    const { result } = renderHook(() => usePlaybackSession(deps));
    const subFile = new File(['x'], 'sub.ass', { type: 'text/plain' });
    const item = makeFileItem('Show - 01.mkv', 1, { file: subFile, type: 'ass' });

    act(() => { result.current.play(item, { 1: { dandanEpisodeId: 100 } }); });

    expect(MockWorker.instances).toHaveLength(0);
    expect(deps.getSubtitleUrl).toHaveBeenCalledWith(subFile);
    expect(result.current.subtitleType).toBe('ass');
    expect(result.current.subtitleUrl).toBe('blob:sub-sub.ass');
  });
});

describe('usePlaybackSession — null episodeMap edge case', () => {
  it('plays cleanly without crashing and clears comments when episodeMap is null', () => {
    const deps = makeDeps();
    const { result } = renderHook(() => usePlaybackSession(deps));

    act(() => { result.current.play(makeFileItem('Show - 01.mkv', 1), null); });

    expect(deps.loadComments).not.toHaveBeenCalled();
    expect(deps.clearComments).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe('playing');
    expect(result.current.playingEp).toBe(1);
  });

  it('clears comments when episodeMap has no dandanEpisodeId for the file', () => {
    const deps = makeDeps();
    const { result } = renderHook(() => usePlaybackSession(deps));

    act(() => { result.current.play(makeFileItem('Show - 01.mkv', 1), { 1: { title: 'no id' } }); });

    expect(deps.loadComments).not.toHaveBeenCalled();
    expect(deps.clearComments).toHaveBeenCalledTimes(1);
  });
});

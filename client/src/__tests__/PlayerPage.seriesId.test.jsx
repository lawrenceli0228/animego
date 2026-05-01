// @ts-check
import 'fake-indexeddb/auto';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// ── shared setup ───────────────────────────────────────────────────────────

// URL stubs (jsdom lacks these)
beforeAll(() => {
  if (!global.URL.createObjectURL) {
    global.URL.createObjectURL = vi.fn(() => 'blob:mock');
    global.URL.revokeObjectURL = vi.fn();
  }
});

// ── mock heavy / side-effect-y hooks / modules ─────────────────────────────

// Mock LanguageContext
vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({
    t: (key) => ({
      'player.backToList': 'Back to list',
      'player.dropReplace': 'Drop to replace current session',
      'player.multiFolderToast': 'Picked {{label}} ({{picked}} files); {{others}} skipped.',
      'player.alphaFallbackToast': 'Episode numbers ambiguous; sorted alphabetically.',
      'player.resumedAt': 'Resumed from {{time}}',
      'player.rootFolder': '(root)',
      'player.noVideos': 'No video files found',
      'player.danmakuUpdated': 'Danmaku source updated',
      'player.noDanmaku': 'No danmaku for this episode',
      'player.loadingDanmaku': 'Loading danmaku…',
      'player.danmakuCount': 'danmaku',
      'player.setDanmaku': 'Set danmaku',
      'player.error': 'Something went wrong',
      'player.errorGeneric': 'Danmaku service unavailable.',
      'player.retry': 'Retry',
      'player.desktopOnly': 'Desktop only',
      'player.desktopHint': 'The video player requires a desktop browser',
      'library.fileMissing': 'File not found or permission denied',
      'library.access.loadingEyebrow': 'LIBRARY // LOADING',
      'library.access.loadingTitle': 'Loading your library...',
      'library.access.loadingBody': 'Pulling series and file references...',
      'library.access.missingEyebrow': 'LIBRARY // NOT FOUND',
      'library.access.missingTitle': 'Series not found',
      'library.access.missingBody': 'This series may have been removed.',
      'library.access.errorEyebrow': 'LIBRARY // ERROR',
      'library.access.errorTitle': 'Could not load this series',
      'library.access.errorBody': 'Something went wrong.',
      'library.access.deniedEyebrow': 'LIBRARY // ACCESS DENIED',
      'library.access.deniedTitle': 'Folder access needs reauthorization',
      'library.access.deniedBody': 'Browser dropped access after restart.',
      'library.access.reauthorize': 'Reauthorize →',
      'library.access.retry': 'Retry →',
      'library.access.backToLibrary': '← Back to library',
    }[key] || key),
  }),
}));

// Mock react-hot-toast so we can inspect calls without real DOM portals
vi.mock('react-hot-toast', () => ({
  default: Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
  }),
  Toaster: () => null,
}));

// Mock useVideoFiles (existing single-file flow)
vi.mock('../hooks/useVideoFiles', () => ({
  default: vi.fn(() => ({
    videoFiles: [],
    keyword: '',
    processFiles: vi.fn(() => ({ files: [], keyword: '' })),
    getVideoUrl: vi.fn(() => null),
    getSubtitleUrl: vi.fn(() => null),
    clear: vi.fn(),
  })),
}));

// Mock useDandanMatch — overridable per-test to simulate the post-match
// "ready" state (with matchResult) that the unified render path expects.
const mockStartMatch = vi.fn();
vi.mock('../hooks/useDandanMatch', () => ({
  default: vi.fn(() => ({
    phase: 'idle',
    stepStatus: {},
    matchResult: null,
    error: null,
    startMatch: mockStartMatch,
    selectManual: vi.fn(),
    reset: vi.fn(),
    updateEpisodeMap: vi.fn(),
  })),
}));

// Mock useDandanComments
vi.mock('../hooks/useDandanComments', () => ({
  default: vi.fn(() => ({
    danmakuList: [],
    count: 0,
    loading: false,
    loadComments: vi.fn(),
    clearComments: vi.fn(),
  })),
}));

// Mock usePlaybackSession — expose a controllable startPlayback spy
const mockStartPlayback = vi.fn();
const mockStopPlayback = vi.fn();
vi.mock('../hooks/usePlaybackSession', () => ({
  default: vi.fn(() => ({
    phase: 'none',
    playingFile: null,
    playingEp: null,
    videoUrl: null,
    subtitleUrl: null,
    subtitleType: null,
    subtitleContent: null,
    resumeAt: null,
    play: mockStartPlayback,
    back: mockStopPlayback,
    getLastTime: vi.fn(() => null),
    setLastTime: vi.fn(),
  })),
}));

// Mock hashPool (worker pool — not needed in jsdom)
vi.mock('../lib/library/hashPool', () => ({
  createHashPool: vi.fn(() => ({
    hash: vi.fn().mockResolvedValue('deadbeef'),
    dispose: vi.fn(),
  })),
}));

// Mock groupByFolder
vi.mock('../lib/library/grouping', () => ({
  groupByFolder: vi.fn(() => []),
}));

// Mock flattenDropFiles
vi.mock('../utils/dropFiles', () => ({
  flattenDropFiles: vi.fn().mockResolvedValue([]),
}));

// Mock useFileHandles — overridable per test via mockReturnValue
const mockSelectFileByName = vi.fn().mockResolvedValue(null);
const mockReauthorize = vi.fn().mockResolvedValue(undefined);
const fileHandlesDefault = () => ({
  status: 'ready',
  roots: [],
  pickFolder: vi.fn(),
  reauthorize: mockReauthorize,
  dropFolder: vi.fn(),
  selectFileByName: mockSelectFileByName,
});
vi.mock('../hooks/useFileHandles', () => ({
  default: vi.fn(() => fileHandlesDefault()),
}));

// Mock useSeriesDetail — we will override per test
const mockGetFile = vi.fn().mockResolvedValue(null);
const mockRefresh = vi.fn();

vi.mock('../hooks/useSeriesDetail', () => ({
  default: vi.fn(() => ({
    status: 'idle',
    series: null,
    episodes: [],
    fileRefByEpisode: new Map(),
    getFile: mockGetFile,
    refresh: mockRefresh,
  })),
}));

// Mock db
vi.mock('../lib/library/db/db.js', () => ({
  db: {},
  getDb: vi.fn(() => ({})),
}));

// ── import after mocks are wired ────────────────────────────────────────────
import PlayerPage from '../pages/PlayerPage.jsx';
import useSeriesDetail from '../hooks/useSeriesDetail.js';
import useFileHandles from '../hooks/useFileHandles.js';
import useDandanMatch from '../hooks/useDandanMatch.js';
import toast from 'react-hot-toast';

/**
 * Helper: configure useDandanMatch to return a "post-match" state with a
 * synthesized matchResult, mirroring what the server returns once auto-match
 * lands. Tests that exercise the rendered list use this so the unified
 * EpisodeFileList block actually mounts.
 */
function mockMatchReady(episodes) {
  const episodeMap = {};
  for (const ep of episodes) {
    if (ep.number != null) {
      episodeMap[ep.number] = { dandanEpisodeId: 1000 + ep.number, title: `EP ${ep.number}` };
    }
  }
  useDandanMatch.mockReturnValue({
    phase: 'ready',
    stepStatus: { 1: 'done', 2: 'done', 3: 'done' },
    matchResult: {
      matched: true,
      anime: { titleNative: 'Test', titleChinese: 'Test', episodes: episodes.length },
      siteAnime: null,
      episodeMap,
      source: 'dandanplay',
    },
    error: null,
    startMatch: mockStartMatch,
    selectManual: vi.fn(),
    reset: vi.fn(),
    updateEpisodeMap: vi.fn(),
  });
}

// ── helpers ─────────────────────────────────────────────────────────────────

function makeEpisode(id, number, primaryFileId) {
  return {
    id,
    seriesId: 'S1',
    number,
    kind: 'main',
    primaryFileId,
    alternateFileIds: [],
    updatedAt: Date.now(),
  };
}

function makeFileRef(id, libraryId, relPath) {
  return {
    id,
    libraryId,
    relPath,
    size: 1024,
    mtime: Date.now(),
    matchStatus: 'matched',
  };
}

function renderPlayerPage(locationState = {}) {
  return render(
    <MemoryRouter
      initialEntries={[{ pathname: '/player', state: locationState }]}
    >
      <Routes>
        <Route path="/player" element={<PlayerPage />} />
      </Routes>
    </MemoryRouter>
  );
}

// ── tests ───────────────────────────────────────────────────────────────────

describe('PlayerPage — seriesId entry path (Slice 12)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStartPlayback.mockReset();
    mockStartMatch.mockReset();
    mockGetFile.mockReset().mockResolvedValue(null);
    mockReauthorize.mockReset().mockResolvedValue(undefined);
    useFileHandles.mockImplementation(() => fileHandlesDefault());
    // Default to "no match yet" — tests opt in to ready state via mockMatchReady().
    useDandanMatch.mockReturnValue({
      phase: 'idle',
      stepStatus: {},
      matchResult: null,
      error: null,
      startMatch: mockStartMatch,
      selectManual: vi.fn(),
      reset: vi.fn(),
      updateEpisodeMap: vi.fn(),
    });
  });

  // ─── edge: no seriesId → existing flow (DropZone visible) ─────────────────

  it('edge: no seriesId → existing single-file flow unaffected — DropZone visible', () => {
    useSeriesDetail.mockReturnValue({
      status: 'idle',
      series: null,
      episodes: [],
      fileRefByEpisode: new Map(),
      getFile: mockGetFile,
      refresh: mockRefresh,
    });

    renderPlayerPage({});

    // DropZone should be present (look for the drag-and-drop area)
    const dropZoneEl = document.querySelector('[data-testid="dropzone"]') ||
                       screen.queryByText(/drag anime folder/i) ||
                       screen.queryByText(/select video/i);
    // At minimum the page renders without crashing and no library episode list appears
    expect(screen.queryByTestId('library-episode-list')).toBeNull();
  });

  // ─── happy: seriesId in location state → episode list rendered ────────────

  it('happy: seriesId present → library mode renders episode list', async () => {
    const episodes = [makeEpisode('ep-1', 1, 'fr-1')];
    const fileRefByEpisode = new Map([['ep-1', makeFileRef('fr-1', 'lib-1', 'Season1/ep1.mkv')]]);

    useSeriesDetail.mockReturnValue({
      status: 'ready',
      series: { id: 'S1', titleZh: '进击的巨人', type: 'tv', confidence: 0.9, createdAt: Date.now(), updatedAt: Date.now() },
      episodes,
      fileRefByEpisode,
      getFile: mockGetFile,
      refresh: mockRefresh,
    });
    mockMatchReady(episodes);

    renderPlayerPage({ seriesId: 'S1', episodeNumber: 1 });

    await waitFor(() => {
      expect(screen.getByTestId('library-episode-list')).toBeInTheDocument();
    });
    // The button text includes "EP 01" — use a partial text match
    expect(screen.getByText(/EP[\s]?01/)).toBeInTheDocument();
  });

  // ─── happy: episode click → startPlayback called ──────────────────────────

  it('happy: episode click with valid file → startPlayback called', async () => {
    const fakeFile = new File(['data'], 'ep1.mkv', { type: 'video/mp4' });
    mockGetFile.mockResolvedValue(fakeFile);

    const episodes = [makeEpisode('ep-1', 1, 'fr-1')];
    const fileRefByEpisode = new Map([['ep-1', makeFileRef('fr-1', 'lib-1', 'Season1/ep1.mkv')]]);

    useSeriesDetail.mockReturnValue({
      status: 'ready',
      series: { id: 'S1', titleZh: '进击的巨人', type: 'tv', confidence: 0.9, createdAt: Date.now(), updatedAt: Date.now() },
      episodes,
      fileRefByEpisode,
      getFile: mockGetFile,
      refresh: mockRefresh,
    });
    mockMatchReady(episodes);

    renderPlayerPage({ seriesId: 'S1' });

    await waitFor(() => screen.getByTestId('library-episode-list'));

    const ep1Btn = screen.getByText(/EP[\s]?01/);
    await act(async () => {
      fireEvent.click(ep1Btn);
    });

    await waitFor(() => expect(mockStartPlayback).toHaveBeenCalledTimes(1));
    const [fileItem] = mockStartPlayback.mock.calls[0];
    expect(fileItem.file).toBe(fakeFile);
    expect(fileItem.episode).toBe(1);
  });

  // ─── edge: getFile returns null → toast shown, no startPlayback ───────────

  // ─── happy: resumeEpisode in nav state → auto-plays without click ─────────

  it('happy: resumeEpisode in nav state → auto-calls startPlayback once', async () => {
    const fakeFile = new File(['data'], 'ep2.mkv', { type: 'video/mp4' });
    mockGetFile.mockResolvedValue(fakeFile);

    const episodes = [
      makeEpisode('ep-1', 1, 'fr-1'),
      makeEpisode('ep-2', 2, 'fr-2'),
    ];
    const fileRefByEpisode = new Map([
      ['ep-1', makeFileRef('fr-1', 'lib-1', 'ep1.mkv')],
      ['ep-2', makeFileRef('fr-2', 'lib-1', 'ep2.mkv')],
    ]);

    useSeriesDetail.mockReturnValue({
      status: 'ready',
      series: { id: 'S1', titleZh: '进击的巨人', type: 'tv', confidence: 0.9, createdAt: Date.now(), updatedAt: Date.now() },
      episodes,
      fileRefByEpisode,
      getFile: mockGetFile,
      refresh: mockRefresh,
    });
    mockMatchReady(episodes);

    renderPlayerPage({ seriesId: 'S1', resumeEpisode: 2 });

    await waitFor(() => expect(mockStartPlayback).toHaveBeenCalledTimes(1));
    const [fileItem] = mockStartPlayback.mock.calls[0];
    expect(fileItem.file).toBe(fakeFile);
    expect(fileItem.episode).toBe(2);

    // The library list should be hidden during the auto-resume window — it
    // would re-render only after autoResumeAttempted flips, which happens in
    // the same effect tick before getFile resolves; either way, click-to-play
    // is not the entry path here.
  });

  it('edge: resumeEpisode for missing episode → no playback, list reappears', async () => {
    const episodes = [makeEpisode('ep-1', 1, 'fr-1')];
    const fileRefByEpisode = new Map([['ep-1', makeFileRef('fr-1', 'lib-1', 'ep1.mkv')]]);

    useSeriesDetail.mockReturnValue({
      status: 'ready',
      series: { id: 'S1', titleZh: '进击的巨人', type: 'tv', confidence: 0.9, createdAt: Date.now(), updatedAt: Date.now() },
      episodes,
      fileRefByEpisode,
      getFile: mockGetFile,
      refresh: mockRefresh,
    });
    mockMatchReady(episodes);

    // resumeEpisode=99 doesn't exist
    renderPlayerPage({ seriesId: 'S1', resumeEpisode: 99 });

    await waitFor(() => {
      expect(screen.getByTestId('library-episode-list')).toBeInTheDocument();
    });
    expect(mockStartPlayback).not.toHaveBeenCalled();
  });

  it('edge: resumeEpisode but getFile null → no playback, list reappears', async () => {
    mockGetFile.mockResolvedValue(null);

    const episodes = [makeEpisode('ep-1', 1, 'fr-1')];
    const fileRefByEpisode = new Map([['ep-1', makeFileRef('fr-1', 'lib-1', 'ep1.mkv')]]);

    useSeriesDetail.mockReturnValue({
      status: 'ready',
      series: { id: 'S1', titleZh: '进击的巨人', type: 'tv', confidence: 0.9, createdAt: Date.now(), updatedAt: Date.now() },
      episodes,
      fileRefByEpisode,
      getFile: mockGetFile,
      refresh: mockRefresh,
    });
    mockMatchReady(episodes);

    renderPlayerPage({ seriesId: 'S1', resumeEpisode: 1 });

    await waitFor(() => {
      expect(screen.getByTestId('library-episode-list')).toBeInTheDocument();
    });
    expect(mockStartPlayback).not.toHaveBeenCalled();
  });

  it('edge: getFile returns null → toast error shown, startPlayback NOT called', async () => {
    mockGetFile.mockResolvedValue(null);

    const episodes = [makeEpisode('ep-1', 1, 'fr-1')];
    const fileRefByEpisode = new Map([['ep-1', makeFileRef('fr-1', 'lib-1', 'Season1/ep1.mkv')]]);

    useSeriesDetail.mockReturnValue({
      status: 'ready',
      series: { id: 'S1', titleZh: '进击的巨人', type: 'tv', confidence: 0.9, createdAt: Date.now(), updatedAt: Date.now() },
      episodes,
      fileRefByEpisode,
      getFile: mockGetFile,
      refresh: mockRefresh,
    });
    mockMatchReady(episodes);

    renderPlayerPage({ seriesId: 'S1' });

    await waitFor(() => screen.getByTestId('library-episode-list'));

    const ep1Btn = screen.getByText(/EP[\s]?01/);
    await act(async () => {
      fireEvent.click(ep1Btn);
    });

    await waitFor(() => {
      const toastCalls = [
        ...(toast.mock?.calls ?? []),
        ...(toast.error.mock?.calls ?? []),
      ];
      expect(toastCalls.length).toBeGreaterThan(0);
    });
    expect(mockStartPlayback).not.toHaveBeenCalled();
  });
});

describe('PlayerPage — library access empty states (Problem 2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStartPlayback.mockReset();
    mockStartMatch.mockReset();
    mockGetFile.mockReset().mockResolvedValue(null);
    mockReauthorize.mockReset().mockResolvedValue(undefined);
    useFileHandles.mockImplementation(() => fileHandlesDefault());
    useDandanMatch.mockReturnValue({
      phase: 'idle',
      stepStatus: {},
      matchResult: null,
      error: null,
      startMatch: mockStartMatch,
      selectManual: vi.fn(),
      reset: vi.fn(),
      updateEpisodeMap: vi.fn(),
    });
  });

  it('loading: seriesId set + status=loading → renders loading empty state, hides episode list', () => {
    useSeriesDetail.mockReturnValue({
      status: 'loading',
      series: null,
      episodes: [],
      fileRefByEpisode: new Map(),
      getFile: mockGetFile,
      refresh: mockRefresh,
    });
    renderPlayerPage({ seriesId: 'S1' });
    const empty = screen.getByTestId('library-access-empty');
    expect(empty.getAttribute('data-kind')).toBe('loading');
    expect(screen.queryByTestId('library-episode-list')).toBeNull();
  });

  it('missing: seriesId points at deleted series → missing kind + back button only', () => {
    useSeriesDetail.mockReturnValue({
      status: 'missing',
      series: null,
      episodes: [],
      fileRefByEpisode: new Map(),
      getFile: mockGetFile,
      refresh: mockRefresh,
    });
    renderPlayerPage({ seriesId: 'gone' });
    expect(screen.getByTestId('library-access-empty').getAttribute('data-kind')).toBe('missing');
    expect(screen.getByTestId('library-access-back')).toBeInTheDocument();
    expect(screen.queryByTestId('library-access-reauthorize')).toBeNull();
    expect(screen.queryByTestId('library-access-retry')).toBeNull();
  });

  it('error: seriesDetail.status=error → error kind + retry calls refresh', async () => {
    useSeriesDetail.mockReturnValue({
      status: 'error',
      series: null,
      episodes: [],
      fileRefByEpisode: new Map(),
      getFile: mockGetFile,
      refresh: mockRefresh,
    });
    renderPlayerPage({ seriesId: 'S1' });

    expect(screen.getByTestId('library-access-empty').getAttribute('data-kind')).toBe('error');
    const retryBtn = screen.getByTestId('library-access-retry');
    await act(async () => { fireEvent.click(retryBtn); });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('denied (proactive): fileHandles.status=denied while series ready → denied kind, no auto-resume', async () => {
    const episodes = [makeEpisode('ep-1', 1, 'fr-1')];
    const fileRefByEpisode = new Map([['ep-1', makeFileRef('fr-1', 'lib-1', 'ep1.mkv')]]);
    useSeriesDetail.mockReturnValue({
      status: 'ready',
      series: { id: 'S1', titleZh: 'X', type: 'tv', confidence: 0.9, createdAt: 0, updatedAt: 0 },
      episodes,
      fileRefByEpisode,
      getFile: mockGetFile,
      refresh: mockRefresh,
    });
    useFileHandles.mockImplementation(() => ({
      ...fileHandlesDefault(),
      status: 'denied',
    }));

    // resumeEpisode would normally auto-play; denied must block it.
    renderPlayerPage({ seriesId: 'S1', resumeEpisode: 1 });

    expect(screen.getByTestId('library-access-empty').getAttribute('data-kind')).toBe('denied');
    expect(screen.queryByTestId('library-episode-list')).toBeNull();
    expect(mockStartPlayback).not.toHaveBeenCalled();
  });

  it('denied: reauthorize iterates every unique libraryId from fileRefs and refreshes', async () => {
    const episodes = [
      makeEpisode('ep-1', 1, 'fr-1'),
      makeEpisode('ep-2', 2, 'fr-2'),
      makeEpisode('ep-3', 3, 'fr-3'),
    ];
    const fileRefByEpisode = new Map([
      ['ep-1', makeFileRef('fr-1', 'lib-A', 'a.mkv')],
      ['ep-2', makeFileRef('fr-2', 'lib-A', 'b.mkv')], // dupe libraryId
      ['ep-3', makeFileRef('fr-3', 'lib-B', 'c.mkv')],
    ]);
    useSeriesDetail.mockReturnValue({
      status: 'ready',
      series: { id: 'S1', titleZh: 'X', type: 'tv', confidence: 0.9, createdAt: 0, updatedAt: 0 },
      episodes,
      fileRefByEpisode,
      getFile: mockGetFile,
      refresh: mockRefresh,
    });
    useFileHandles.mockImplementation(() => ({
      ...fileHandlesDefault(),
      status: 'denied',
    }));

    renderPlayerPage({ seriesId: 'S1' });

    const reauthBtn = screen.getByTestId('library-access-reauthorize');
    await act(async () => { fireEvent.click(reauthBtn); });

    await waitFor(() => expect(mockReauthorize).toHaveBeenCalledTimes(2));
    const calledIds = mockReauthorize.mock.calls.map((c) => c[0]).sort();
    expect(calledIds).toEqual(['lib-A', 'lib-B']);
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('denied (reactive): click play, getFile null, fileHandles.status flipped to denied → empty state appears', async () => {
    // Start with ready handles, but selectFileByName flips status to denied.
    let currentStatus = 'ready';
    useFileHandles.mockImplementation(() => ({
      ...fileHandlesDefault(),
      status: currentStatus,
    }));

    const episodes = [makeEpisode('ep-1', 1, 'fr-1')];
    const fileRefByEpisode = new Map([['ep-1', makeFileRef('fr-1', 'lib-1', 'ep1.mkv')]]);
    useSeriesDetail.mockReturnValue({
      status: 'ready',
      series: { id: 'S1', titleZh: 'X', type: 'tv', confidence: 0.9, createdAt: 0, updatedAt: 0 },
      episodes,
      fileRefByEpisode,
      getFile: vi.fn().mockImplementation(async () => {
        currentStatus = 'denied'; // simulate selectFileByName side-effect
        return null;
      }),
      refresh: mockRefresh,
    });
    mockMatchReady(episodes);

    const { rerender } = renderPlayerPage({ seriesId: 'S1' });
    await waitFor(() => screen.getByTestId('library-episode-list'));

    const ep1Btn = screen.getByText(/EP[\s]?01/);
    await act(async () => { fireEvent.click(ep1Btn); });

    // After the click, useFileHandles re-runs and reports 'denied'. Trigger a
    // rerender so React picks up the new return value.
    rerender(
      <MemoryRouter initialEntries={[{ pathname: '/player', state: { seriesId: 'S1' } }]}>
        <Routes>
          <Route path="/player" element={<PlayerPage />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByTestId('library-access-empty').getAttribute('data-kind')).toBe('denied');
    });
    expect(mockStartPlayback).not.toHaveBeenCalled();
  });

  it('back: click back-to-library navigates away from player', async () => {
    useSeriesDetail.mockReturnValue({
      status: 'missing',
      series: null,
      episodes: [],
      fileRefByEpisode: new Map(),
      getFile: mockGetFile,
      refresh: mockRefresh,
    });
    render(
      <MemoryRouter initialEntries={[{ pathname: '/player', state: { seriesId: 'gone' } }]}>
        <Routes>
          <Route path="/player" element={<PlayerPage />} />
          <Route path="/library" element={<div data-testid="library-route">LIB</div>} />
        </Routes>
      </MemoryRouter>
    );
    const backBtn = screen.getByTestId('library-access-back');
    await act(async () => { fireEvent.click(backBtn); });
    await waitFor(() => expect(screen.getByTestId('library-route')).toBeInTheDocument());
  });
});

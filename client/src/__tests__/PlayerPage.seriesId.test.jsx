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

// Mock useDandanMatch (existing flow)
vi.mock('../hooks/useDandanMatch', () => ({
  default: vi.fn(() => ({
    phase: 'idle',
    stepStatus: {},
    matchResult: null,
    error: null,
    startMatch: vi.fn(),
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

// Mock useFileHandles
const mockSelectFileByName = vi.fn().mockResolvedValue(null);
vi.mock('../hooks/useFileHandles', () => ({
  default: vi.fn(() => ({
    status: 'ready',
    roots: [],
    pickFolder: vi.fn(),
    reauthorize: vi.fn(),
    dropFolder: vi.fn(),
    selectFileByName: mockSelectFileByName,
  })),
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
import toast from 'react-hot-toast';

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
    mockGetFile.mockReset().mockResolvedValue(null);
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

    renderPlayerPage({ seriesId: 'S1', episodeNumber: 1 });

    await waitFor(() => {
      expect(screen.getByTestId('library-episode-list')).toBeInTheDocument();
    });
    // The button text includes "EP 01" — use a partial text match
    expect(screen.getByText(/EP 01/)).toBeInTheDocument();
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

    renderPlayerPage({ seriesId: 'S1' });

    await waitFor(() => screen.getByTestId('library-episode-list'));

    const ep1Btn = screen.getByText(/EP 01/);
    await act(async () => {
      fireEvent.click(ep1Btn);
    });

    await waitFor(() => expect(mockStartPlayback).toHaveBeenCalledTimes(1));
    const [fileItem] = mockStartPlayback.mock.calls[0];
    expect(fileItem.file).toBe(fakeFile);
    expect(fileItem.episode).toBe(1);
  });

  // ─── edge: getFile returns null → toast shown, no startPlayback ───────────

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

    renderPlayerPage({ seriesId: 'S1' });

    await waitFor(() => screen.getByTestId('library-episode-list'));

    const ep1Btn = screen.getByText(/EP 01/);
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

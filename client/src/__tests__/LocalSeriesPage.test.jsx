// @ts-check
import 'fake-indexeddb/auto';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// ── mock hooks / modules used by LocalSeriesPage ──────────────────────────────

// ManualSearch (used inside RematchDialog) reads from useLang(). Provide a
// no-op implementation so tests don't have to wrap every render in a provider.
vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({ lang: 'zh', t: (k) => k, toggle: () => {} }),
  LanguageProvider: ({ children }) => children,
}));

vi.mock('../hooks/useFileHandles', () => ({
  default: vi.fn(() => ({
    status: 'ready',
    roots: [],
    pickFolder: vi.fn(),
    reauthorize: vi.fn(),
    dropFolder: vi.fn(),
    selectFileByName: vi.fn().mockResolvedValue(null),
  })),
}));

const mockSeriesDetail = {
  status: 'ready',
  series: null,
  episodes: [],
  fileRefByEpisode: new Map(),
  getFile: vi.fn(),
  refresh: vi.fn(),
};
vi.mock('../hooks/useSeriesDetail', () => ({
  default: vi.fn(() => mockSeriesDetail),
}));

const mockGetBySeries = vi.fn().mockResolvedValue([]);
vi.mock('../lib/library/db/progressRepo.js', () => ({
  makeProgressRepo: vi.fn(() => ({
    get: vi.fn(),
    put: vi.fn(),
    getBySeries: mockGetBySeries,
    latestPerSeries: vi.fn(),
    delete: vi.fn(),
  })),
}));

const mockListForSeries = vi.fn().mockResolvedValue([]);
vi.mock('../lib/library/db/opsLogRepo.js', () => ({
  makeOpsLogRepo: vi.fn(() => ({
    append: vi.fn(),
    get: vi.fn(),
    listForSeries: mockListForSeries,
    markUndone: vi.fn(),
    gc: vi.fn(),
  })),
}));

// Minimal db mock: enough surface for useLibrary's liveQuery and SplitDialog's
// season prefetch. Tables not exercised by the page may simply be missing.
vi.mock('../lib/library/db/db.js', () => ({
  db: {
    seasons: {
      where: () => ({
        equals: () => ({ toArray: () => Promise.resolve([]) }),
      }),
    },
    series: {
      orderBy: () => ({
        reverse: () => ({ toArray: () => Promise.resolve([]) }),
      }),
    },
    episodes: {
      update: vi.fn().mockResolvedValue(1),
    },
    userOverride: { toArray: () => Promise.resolve([]) },
  },
  getDb: vi.fn(() => ({})),
}));

// ── import after mocks are wired ──────────────────────────────────────────────

import LocalSeriesPage from '../pages/LocalSeriesPage.jsx';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeSeries(over = {}) {
  return {
    id: 'series-1',
    titleZh: '进击的巨人',
    titleEn: 'Attack on Titan',
    type: 'tv',
    confidence: 0.9,
    totalEpisodes: 12,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function makeEpisode(id, number, over = {}) {
  return {
    id,
    seriesId: 'series-1',
    number,
    kind: 'main',
    primaryFileId: `file-${number}`,
    alternateFileIds: [],
    updatedAt: 0,
    ...over,
  };
}

function makeFileRef(id, relPath, libraryId = 'lib-1') {
  return { id, libraryId, relPath, size: 1024, mtime: 0, matchStatus: 'matched' };
}

function makeProgress(episodeId, seriesId, over = {}) {
  return {
    episodeId,
    seriesId,
    positionSec: 0,
    durationSec: 1440,
    updatedAt: 0,
    completed: false,
    ...over,
  };
}

function renderAt(seriesId) {
  return render(
    <MemoryRouter initialEntries={[`/library/${seriesId}`]}>
      <Routes>
        <Route path="/library/:seriesId" element={<LocalSeriesPage />} />
        <Route path="/library" element={<div data-testid="library-route">library</div>} />
        <Route path="/player" element={<div data-testid="player-route">player</div>} />
      </Routes>
    </MemoryRouter>
  );
}

// ── reset state before each test ──────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockSeriesDetail.status = 'ready';
  mockSeriesDetail.series = null;
  mockSeriesDetail.episodes = [];
  mockSeriesDetail.fileRefByEpisode = new Map();
  mockGetBySeries.mockReset().mockResolvedValue([]);
  mockListForSeries.mockReset().mockResolvedValue([]);
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe('LocalSeriesPage — render states', () => {
  it('renders loading state initially', () => {
    mockSeriesDetail.status = 'loading';
    renderAt('series-1');
    expect(screen.getByTestId('loading-state')).toBeInTheDocument();
  });

  it('renders missing state when series is not found', () => {
    mockSeriesDetail.status = 'missing';
    renderAt('series-1');
    expect(screen.getByTestId('missing-state')).toBeInTheDocument();
  });

  it('renders error state when load fails', () => {
    mockSeriesDetail.status = 'error';
    renderAt('series-1');
    expect(screen.getByTestId('error-state')).toBeInTheDocument();
  });

  it('renders missing state when series record is loaded but null', () => {
    mockSeriesDetail.status = 'ready';
    mockSeriesDetail.series = null;
    renderAt('series-1');
    expect(screen.getByTestId('missing-state')).toBeInTheDocument();
  });
});

describe('LocalSeriesPage — series list (rich EpisodeFileList)', () => {
  it('renders the series title from titleZh in the list header', () => {
    mockSeriesDetail.series = makeSeries({ titleJa: undefined });
    mockSeriesDetail.episodes = [makeEpisode('e1', 1)];
    renderAt('series-1');
    // titleNative falls back to titleEn → titleZh; titleChinese is titleZh
    expect(screen.getByTestId('series-list')).toBeInTheDocument();
    expect(screen.getByText('Attack on Titan')).toBeInTheDocument();
    expect(screen.getByText('进击的巨人')).toBeInTheDocument();
  });

  it('renders an https poster when provided', () => {
    mockSeriesDetail.series = makeSeries({ posterUrl: 'https://example.com/p.jpg' });
    mockSeriesDetail.episodes = [makeEpisode('e1', 1)];
    const { container } = renderAt('series-1');
    // EpisodeFileList renders the cover with alt="" (decorative), so it has
    // role="presentation" — use a direct DOM query instead of getByRole.
    const img = container.querySelector('img[src="https://example.com/p.jpg"]');
    expect(img).toBeTruthy();
  });

  it('omits poster when posterUrl is non-https (xss guard)', () => {
    mockSeriesDetail.series = makeSeries({ posterUrl: 'javascript:alert(1)' });
    mockSeriesDetail.episodes = [makeEpisode('e1', 1)];
    const { container } = renderAt('series-1');
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders one row per episode', () => {
    mockSeriesDetail.series = makeSeries();
    mockSeriesDetail.episodes = [makeEpisode('e1', 1), makeEpisode('e2', 2)];
    renderAt('series-1');
    expect(screen.getByText(/EP01/)).toBeInTheDocument();
    expect(screen.getByText(/EP02/)).toBeInTheDocument();
  });

  it('clicking an episode row navigates to /player with seriesId + episode', () => {
    mockSeriesDetail.series = makeSeries();
    mockSeriesDetail.episodes = [makeEpisode('e1', 5)];
    mockSeriesDetail.fileRefByEpisode = new Map([
      ['e1', makeFileRef('file-5', 'EP05.mkv')],
    ]);
    renderAt('series-1');
    // 'EP05.mkv' appears both in the EpisodeFileList row and the file-tree
    // section below — scope to the EpisodeFileList wrapper to disambiguate.
    const list = screen.getByTestId('series-list');
    fireEvent.click(within(list).getByText('EP05.mkv'));
    expect(screen.getByTestId('player-route')).toBeInTheDocument();
  });

  it('returnToLibrary button (// 返回库 //) navigates to /library', () => {
    mockSeriesDetail.series = makeSeries();
    mockSeriesDetail.episodes = [makeEpisode('e1', 1)];
    renderAt('series-1');
    // The label appears in the EpisodeFileList header actions
    fireEvent.click(screen.getByText(/返回库/));
    expect(screen.getByTestId('library-route')).toBeInTheDocument();
  });
});

describe('LocalSeriesPage — file source', () => {
  it('lists distinct source folders from fileRefs', () => {
    mockSeriesDetail.series = makeSeries();
    mockSeriesDetail.episodes = [makeEpisode('e1', 1), makeEpisode('e2', 2)];
    mockSeriesDetail.fileRefByEpisode = new Map([
      ['e1', makeFileRef('file-1', '正片/EP01.mkv')],
      ['e2', makeFileRef('file-2', 'SPs/EP02.mkv')],
    ]);
    renderAt('series-1');
    const list = screen.getByTestId('source-list');
    expect(list.textContent).toMatch(/正片/);
    expect(list.textContent).toMatch(/SPs/);
  });

  it('treats root-level files as (根)', () => {
    mockSeriesDetail.series = makeSeries();
    mockSeriesDetail.episodes = [makeEpisode('e1', 1)];
    mockSeriesDetail.fileRefByEpisode = new Map([
      ['e1', makeFileRef('file-1', 'EP01.mkv')],
    ]);
    renderAt('series-1');
    expect(screen.getByTestId('source-list').textContent).toMatch(/\(根\)/);
  });

  it('hides source list when no fileRefs are known', () => {
    mockSeriesDetail.series = makeSeries();
    mockSeriesDetail.episodes = [makeEpisode('e1', 1)];
    renderAt('series-1');
    expect(screen.queryByTestId('source-list')).not.toBeInTheDocument();
  });

  it('renders a folder group per distinct folder', () => {
    mockSeriesDetail.series = makeSeries();
    mockSeriesDetail.episodes = [makeEpisode('e1', 1), makeEpisode('e2', 2)];
    mockSeriesDetail.fileRefByEpisode = new Map([
      ['e1', makeFileRef('file-1', '正片/EP01.mkv')],
      ['e2', makeFileRef('file-2', 'SPs/EP02.mkv')],
    ]);
    renderAt('series-1');
    expect(screen.getByTestId('folder-group-正片')).toBeInTheDocument();
    expect(screen.getByTestId('folder-group-SPs')).toBeInTheDocument();
  });

  it('renders a file row per episode with EP badge and filename', () => {
    mockSeriesDetail.series = makeSeries();
    mockSeriesDetail.episodes = [makeEpisode('e1', 1), makeEpisode('e2', 2)];
    mockSeriesDetail.fileRefByEpisode = new Map([
      ['e1', makeFileRef('file-1', '正片/EP01.mkv')],
      ['e2', makeFileRef('file-2', '正片/EP02.mkv')],
    ]);
    renderAt('series-1');
    const row1 = screen.getByTestId('file-row-e1');
    expect(row1.textContent).toMatch(/EP01/);
    expect(row1.textContent).toMatch(/EP01\.mkv/);
    const row2 = screen.getByTestId('file-row-e2');
    expect(row2.textContent).toMatch(/EP02/);
  });

  it('shows ✓ on watched files only', async () => {
    mockSeriesDetail.series = makeSeries();
    mockSeriesDetail.episodes = [makeEpisode('e1', 1), makeEpisode('e2', 2)];
    mockSeriesDetail.fileRefByEpisode = new Map([
      ['e1', makeFileRef('file-1', '正片/EP01.mkv')],
      ['e2', makeFileRef('file-2', '正片/EP02.mkv')],
    ]);
    mockGetBySeries.mockResolvedValue([
      makeProgress('e1', 'series-1', { completed: true }),
    ]);
    renderAt('series-1');
    await waitFor(() => {
      expect(screen.getByTestId('file-watched-e1').textContent).toBe('✓');
    });
    expect(screen.getByTestId('file-watched-e2').textContent).toBe('');
  });
});

describe('LocalSeriesPage — back button', () => {
  it('navigates to /library when clicked', () => {
    mockSeriesDetail.series = makeSeries();
    mockSeriesDetail.episodes = [makeEpisode('e1', 1)];
    renderAt('series-1');
    fireEvent.click(screen.getByTestId('back-btn'));
    expect(screen.getByTestId('library-route')).toBeInTheDocument();
  });
});

describe('LocalSeriesPage — Actions menu', () => {
  it('hides Actions menu in loading / error / missing states', () => {
    mockSeriesDetail.status = 'loading';
    const { unmount } = renderAt('series-1');
    expect(screen.queryByTestId('actions-btn')).not.toBeInTheDocument();
    unmount();

    mockSeriesDetail.status = 'error';
    const e = renderAt('series-1');
    expect(screen.queryByTestId('actions-btn')).not.toBeInTheDocument();
    e.unmount();

    mockSeriesDetail.status = 'missing';
    renderAt('series-1');
    expect(screen.queryByTestId('actions-btn')).not.toBeInTheDocument();
  });

  it('shows the Actions menu trigger on the loaded detail page', () => {
    mockSeriesDetail.series = makeSeries();
    mockSeriesDetail.episodes = [makeEpisode('e1', 1)];
    renderAt('series-1');
    expect(screen.getByTestId('actions-btn')).toBeInTheDocument();
  });

  it('clicking [合并到其他系列] opens the MergeDialog', async () => {
    mockSeriesDetail.series = makeSeries();
    mockSeriesDetail.episodes = [makeEpisode('e1', 1)];
    renderAt('series-1');
    fireEvent.click(screen.getByTestId('actions-btn'));
    fireEvent.click(screen.getByTestId('action-merge'));
    await waitFor(() => {
      expect(screen.getByTestId('merge-dialog')).toBeInTheDocument();
    });
  });

  it('clicking [拆分此系列] opens the SplitDialog', async () => {
    mockSeriesDetail.series = makeSeries();
    mockSeriesDetail.episodes = [makeEpisode('e1', 1)];
    renderAt('series-1');
    fireEvent.click(screen.getByTestId('actions-btn'));
    fireEvent.click(screen.getByTestId('action-split'));
    await waitFor(() => {
      expect(screen.getByTestId('split-dialog')).toBeInTheDocument();
    });
  });

  it('clicking [重新匹配] opens the RematchDialog', async () => {
    mockSeriesDetail.series = makeSeries();
    mockSeriesDetail.episodes = [makeEpisode('e1', 1)];
    renderAt('series-1');
    fireEvent.click(screen.getByTestId('actions-btn'));
    fireEvent.click(screen.getByTestId('action-rematch'));
    await waitFor(() => {
      expect(screen.getByTestId('rematch-dialog')).toBeInTheDocument();
    });
  });

  it('Cancel on MergeDialog closes it without errors', async () => {
    mockSeriesDetail.series = makeSeries();
    mockSeriesDetail.episodes = [makeEpisode('e1', 1)];
    renderAt('series-1');
    fireEvent.click(screen.getByTestId('actions-btn'));
    fireEvent.click(screen.getByTestId('action-merge'));
    await waitFor(() => expect(screen.getByTestId('merge-dialog')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('merge-cancel'));
    await waitFor(() => {
      expect(screen.queryByTestId('merge-dialog')).not.toBeInTheDocument();
    });
  });
});

describe('LocalSeriesPage — Ops log drawer', () => {
  it('exposes [操作日志] in the Actions menu', () => {
    mockSeriesDetail.series = makeSeries();
    mockSeriesDetail.episodes = [makeEpisode('e1', 1)];
    renderAt('series-1');
    fireEvent.click(screen.getByTestId('actions-btn'));
    expect(screen.getByTestId('action-opslog')).toBeInTheDocument();
  });

  it('clicking [操作日志] opens the drawer and queries listForSeries', async () => {
    mockSeriesDetail.series = makeSeries();
    mockSeriesDetail.episodes = [makeEpisode('e1', 1)];
    mockListForSeries.mockResolvedValue([
      {
        id: 'op_1',
        seriesId: 'series-1',
        ts: Date.now() - 30_000,
        kind: 'merge',
        payload: {},
        summary: { sourceTitle: 'A', targetTitle: 'B' },
        undoableUntil: Date.now() + 86_400_000,
        undone: false,
      },
    ]);
    renderAt('series-1');
    fireEvent.click(screen.getByTestId('actions-btn'));
    fireEvent.click(screen.getByTestId('action-opslog'));
    await waitFor(() => {
      expect(screen.getByTestId('opslog-drawer')).toBeInTheDocument();
    });
    expect(mockListForSeries).toHaveBeenCalledWith('series-1', { limit: 50 });
    await waitFor(() => {
      expect(screen.getByTestId('opslog-row-op_1')).toBeInTheDocument();
    });
  });

  it('clicking close dismisses the drawer', async () => {
    mockSeriesDetail.series = makeSeries();
    mockSeriesDetail.episodes = [makeEpisode('e1', 1)];
    renderAt('series-1');
    fireEvent.click(screen.getByTestId('actions-btn'));
    fireEvent.click(screen.getByTestId('action-opslog'));
    await waitFor(() => expect(screen.getByTestId('opslog-drawer')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('opslog-close'));
    await waitFor(() => {
      expect(screen.queryByTestId('opslog-drawer')).not.toBeInTheDocument();
    });
  });
});

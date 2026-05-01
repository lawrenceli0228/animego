// @ts-check
import 'fake-indexeddb/auto';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

function renderAt(seriesId, navSpy) {
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
});

describe('LocalSeriesPage — hero', () => {
  it('renders the series title from titleZh', () => {
    mockSeriesDetail.series = makeSeries();
    renderAt('series-1');
    expect(screen.getByTestId('hero-title').textContent).toBe('进击的巨人');
  });

  it('falls back to titleEn when titleZh is missing', () => {
    mockSeriesDetail.series = makeSeries({ titleZh: undefined });
    renderAt('series-1');
    expect(screen.getByTestId('hero-title').textContent).toBe('Attack on Titan');
  });

  it('renders LOCAL badge', () => {
    mockSeriesDetail.series = makeSeries();
    renderAt('series-1');
    expect(screen.getByTestId('hero-local-badge')).toBeInTheDocument();
  });

  it('renders monogram fallback when posterUrl is absent', () => {
    mockSeriesDetail.series = makeSeries({ posterUrl: undefined });
    renderAt('series-1');
    expect(screen.getByTestId('hero-monogram')).toBeInTheDocument();
  });

  it('renders an https poster when provided', () => {
    mockSeriesDetail.series = makeSeries({ posterUrl: 'https://example.com/p.jpg' });
    renderAt('series-1');
    const img = screen.getByRole('img');
    expect(img).toHaveAttribute('src', 'https://example.com/p.jpg');
  });

  it('rejects non-https posterUrl (xss guard)', () => {
    mockSeriesDetail.series = makeSeries({ posterUrl: 'javascript:alert(1)' });
    renderAt('series-1');
    expect(screen.getByTestId('hero-monogram')).toBeInTheDocument();
  });
});

describe('LocalSeriesPage — episode list', () => {
  it('renders one row per episode, sorted by number', () => {
    mockSeriesDetail.series = makeSeries();
    mockSeriesDetail.episodes = [
      makeEpisode('e1', 1, { title: 'first' }),
      makeEpisode('e2', 2, { title: 'second' }),
    ];
    renderAt('series-1');
    expect(screen.getByTestId('episode-row-1')).toBeInTheDocument();
    expect(screen.getByTestId('episode-row-2')).toBeInTheDocument();
  });

  it('shows empty state when no episodes', () => {
    mockSeriesDetail.series = makeSeries();
    mockSeriesDetail.episodes = [];
    renderAt('series-1');
    expect(screen.getByTestId('no-episodes')).toBeInTheDocument();
  });

  it('shows ✓ done status for completed episodes', async () => {
    mockSeriesDetail.series = makeSeries();
    mockSeriesDetail.episodes = [makeEpisode('e1', 1)];
    mockGetBySeries.mockResolvedValue([
      makeProgress('e1', 'series-1', { completed: true, positionSec: 1440 }),
    ]);
    renderAt('series-1');
    await waitFor(() => {
      expect(screen.getByTestId('episode-status-1').textContent).toMatch(/看过/);
    });
  });

  it('shows progress label for in-progress episodes', async () => {
    mockSeriesDetail.series = makeSeries();
    mockSeriesDetail.episodes = [makeEpisode('e1', 1)];
    mockGetBySeries.mockResolvedValue([
      makeProgress('e1', 'series-1', { positionSec: 600, durationSec: 1440 }),
    ]);
    renderAt('series-1');
    await waitFor(() => {
      expect(screen.getByTestId('episode-status-1').textContent).toMatch(/进行中/);
    });
  });

  it('shows 未看 for episodes with no progress', () => {
    mockSeriesDetail.series = makeSeries();
    mockSeriesDetail.episodes = [makeEpisode('e1', 1)];
    renderAt('series-1');
    expect(screen.getByTestId('episode-status-1').textContent).toMatch(/未看/);
  });

  it('clicking an episode navigates to /player with seriesId + episode number', () => {
    mockSeriesDetail.series = makeSeries();
    mockSeriesDetail.episodes = [makeEpisode('e1', 5)];
    renderAt('series-1');
    fireEvent.click(screen.getByTestId('episode-row-5'));
    expect(screen.getByTestId('player-route')).toBeInTheDocument();
  });
});

describe('LocalSeriesPage — overall progress + continue CTA', () => {
  it('shows watched / total counter', () => {
    mockSeriesDetail.series = makeSeries();
    mockSeriesDetail.episodes = [makeEpisode('e1', 1), makeEpisode('e2', 2)];
    renderAt('series-1');
    expect(screen.getByTestId('overall-progress').textContent).toMatch(/0 \/ 2/);
  });

  it('reflects watched count from progress data', async () => {
    mockSeriesDetail.series = makeSeries();
    mockSeriesDetail.episodes = [makeEpisode('e1', 1), makeEpisode('e2', 2)];
    mockGetBySeries.mockResolvedValue([
      makeProgress('e1', 'series-1', { completed: true }),
    ]);
    renderAt('series-1');
    await waitFor(() => {
      expect(screen.getByTestId('overall-progress').textContent).toMatch(/1 \/ 2/);
    });
  });

  it('continue button targets the most-recent in-progress episode', async () => {
    mockSeriesDetail.series = makeSeries();
    mockSeriesDetail.episodes = [
      makeEpisode('e1', 1),
      makeEpisode('e2', 2),
      makeEpisode('e3', 3),
    ];
    mockGetBySeries.mockResolvedValue([
      makeProgress('e2', 'series-1', { positionSec: 300, updatedAt: 1000 }),
    ]);
    renderAt('series-1');
    await waitFor(() => {
      expect(screen.getByTestId('continue-btn').textContent).toMatch(/EP02/);
    });
  });

  it('continue button picks first episode when nothing has been watched', () => {
    mockSeriesDetail.series = makeSeries();
    mockSeriesDetail.episodes = [makeEpisode('e1', 1), makeEpisode('e2', 2)];
    renderAt('series-1');
    expect(screen.getByTestId('continue-btn').textContent).toMatch(/EP01/);
  });

  it('clicking continue navigates to /player', async () => {
    mockSeriesDetail.series = makeSeries();
    mockSeriesDetail.episodes = [makeEpisode('e1', 1)];
    renderAt('series-1');
    fireEvent.click(screen.getByTestId('continue-btn'));
    expect(screen.getByTestId('player-route')).toBeInTheDocument();
  });

  it('hides continue button when there are no episodes', () => {
    mockSeriesDetail.series = makeSeries();
    mockSeriesDetail.episodes = [];
    renderAt('series-1');
    expect(screen.queryByTestId('continue-btn')).not.toBeInTheDocument();
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
});

describe('LocalSeriesPage — back button', () => {
  it('navigates to /library when clicked', () => {
    mockSeriesDetail.series = makeSeries();
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
    renderAt('series-1');
    expect(screen.getByTestId('actions-btn')).toBeInTheDocument();
  });

  it('clicking [合并到其他系列] opens the MergeDialog', async () => {
    mockSeriesDetail.series = makeSeries();
    renderAt('series-1');
    fireEvent.click(screen.getByTestId('actions-btn'));
    fireEvent.click(screen.getByTestId('action-merge'));
    await waitFor(() => {
      expect(screen.getByTestId('merge-dialog')).toBeInTheDocument();
    });
  });

  it('clicking [拆分此系列] opens the SplitDialog', async () => {
    mockSeriesDetail.series = makeSeries();
    renderAt('series-1');
    fireEvent.click(screen.getByTestId('actions-btn'));
    fireEvent.click(screen.getByTestId('action-split'));
    await waitFor(() => {
      expect(screen.getByTestId('split-dialog')).toBeInTheDocument();
    });
  });

  it('clicking [重新匹配] opens the RematchDialog', async () => {
    mockSeriesDetail.series = makeSeries();
    renderAt('series-1');
    fireEvent.click(screen.getByTestId('actions-btn'));
    fireEvent.click(screen.getByTestId('action-rematch'));
    await waitFor(() => {
      expect(screen.getByTestId('rematch-dialog')).toBeInTheDocument();
    });
  });

  it('Cancel on MergeDialog closes it without errors', async () => {
    mockSeriesDetail.series = makeSeries();
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

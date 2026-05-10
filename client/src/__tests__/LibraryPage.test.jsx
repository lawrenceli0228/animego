import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import LibraryPage from '../pages/LibraryPage';

// ─── mock hooks ─────────────────────────────────────────────────────────────

vi.mock('../hooks/useLibrary', () => ({
  default: vi.fn(() => ({ series: [], loading: false, refetch: vi.fn() })),
}));
vi.mock('../hooks/useFileHandles', () => ({
  default: vi.fn(() => ({
    status: 'ready',
    roots: [],
    libraryStatus: new Map(),
    pickFolder: vi.fn(),
    reauthorize: vi.fn(),
    dropFolder: vi.fn(),
    selectFileByName: vi.fn(),
    refresh: vi.fn(),
  })),
}));
vi.mock('../hooks/useSeriesLibraryStatus', () => ({
  default: vi.fn(() => ({
    availabilityBySeries: new Map(),
    offlineLibraryIds: [],
    ready: true,
  })),
}));
vi.mock('../hooks/useImport', () => ({
  default: vi.fn(() => ({
    run: vi.fn(),
    progress: [],
    summary: null,
    status: 'idle',
    cancel: vi.fn(),
  })),
}));
vi.mock('../hooks/useVideoFiles', () => ({
  default: vi.fn(() => ({
    videoFiles: [],
    keyword: '',
    processFiles: vi.fn(() => ({ files: [], keyword: '' })),
    getBlobUrl: vi.fn(),
    revokeBlobUrl: vi.fn(),
  })),
}));
vi.mock('../lib/library/handles/fsaFeatureCheck.js', () => ({
  isFsaSupported: vi.fn(() => true),
}));
vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({
    t: (key) => ({
      'library.addFolder': 'Add folder',
      'library.dropFolder': 'Drop folder here',
      'library.unsupportedBanner': 'Your browser does not keep libraries between sessions.',
      'library.recentlyPlayed': 'Recently played',
      'library.localBadge': 'LOCAL',
      'library.reauthorize': 'Reauthorize',
      'library.noSeries': 'No series yet — add a folder to get started.',
    }[key] || key),
  }),
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <LibraryPage />
    </MemoryRouter>
  );
}

describe('LibraryPage', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('shows DropZone empty state when IDB is empty and FSA is supported', async () => {
    renderPage();
    const zone = await screen.findByTestId('dropzone');
    expect(zone).toBeInTheDocument();
    expect(zone.getAttribute('data-state')).toBe('empty');
    expect(screen.getByTestId('dropzone-pick')).toBeInTheDocument();
  });

  it('shows SeriesGrid when series are present', async () => {
    const useLibrary = (await import('../hooks/useLibrary')).default;
    useLibrary.mockReturnValue({
      series: [
        { id: 's1', titleEn: 'Alpha', type: 'tv', confidence: 0.9, createdAt: 1, updatedAt: 1 },
      ],
      loading: false,
      refetch: vi.fn(),
    });
    renderPage();
    expect(await screen.findByText('Alpha')).toBeInTheDocument();
  });

  it('shows FSA unsupported banner when FSA is not supported', async () => {
    const { isFsaSupported } = await import('../lib/library/handles/fsaFeatureCheck.js');
    isFsaSupported.mockReturnValue(false);
    renderPage();
    expect(
      await screen.findByText('Your browser does not keep libraries between sessions.')
    ).toBeInTheDocument();
  });

  it('renders the reauthorize CTA when any library is non-ready and wires it to fileHandles.reauthorize', async () => {
    const useLibrary = (await import('../hooks/useLibrary')).default;
    useLibrary.mockReturnValue({
      series: [{ id: 's1', titleEn: 'Offline Show', type: 'tv', confidence: 0.9, createdAt: 1, updatedAt: 1 }],
      loading: false,
      refetch: vi.fn(),
    });
    const useSeriesLibraryStatus = (await import('../hooks/useSeriesLibraryStatus')).default;
    useSeriesLibraryStatus.mockReturnValue({
      availabilityBySeries: new Map([['s1', 'offline']]),
      offlineLibraryIds: ['lib-1'],
      ready: true,
    });
    const reauthorize = vi.fn().mockResolvedValue();
    const useFileHandles = (await import('../hooks/useFileHandles')).default;
    useFileHandles.mockReturnValue({
      status: 'denied',
      roots: [],
      libraryStatus: new Map([['lib-1', 'denied'], ['lib-2', 'disconnected']]),
      pickFolder: vi.fn(),
      reauthorize,
      dropFolder: vi.fn(),
      selectFileByName: vi.fn(),
      refresh: vi.fn(),
    });

    renderPage();

    const btn = await screen.findByTestId('unavailable-reauthorize');
    fireEvent.click(btn);
    await waitFor(() => {
      expect(reauthorize).toHaveBeenCalledTimes(2);
    });
    expect(reauthorize).toHaveBeenCalledWith('lib-1');
    expect(reauthorize).toHaveBeenCalledWith('lib-2');
  });

  it('omits the reauthorize CTA when every library is ready', async () => {
    const useLibrary = (await import('../hooks/useLibrary')).default;
    useLibrary.mockReturnValue({
      series: [{ id: 's1', titleEn: 'Partial Show', type: 'tv', confidence: 0.9, createdAt: 1, updatedAt: 1 }],
      loading: false,
      refetch: vi.fn(),
    });
    const useSeriesLibraryStatus = (await import('../hooks/useSeriesLibraryStatus')).default;
    useSeriesLibraryStatus.mockReturnValue({
      availabilityBySeries: new Map([['s1', 'partial']]),
      offlineLibraryIds: [],
      ready: true,
    });
    const useFileHandles = (await import('../hooks/useFileHandles')).default;
    useFileHandles.mockReturnValue({
      status: 'ready',
      roots: [],
      libraryStatus: new Map([['lib-1', 'ready']]),
      pickFolder: vi.fn(),
      reauthorize: vi.fn(),
      dropFolder: vi.fn(),
      selectFileByName: vi.fn(),
      refresh: vi.fn(),
    });

    renderPage();

    expect(await screen.findByTestId('unavailable-section')).toBeInTheDocument();
    expect(screen.queryByTestId('unavailable-reauthorize')).toBeNull();
    expect(screen.getByTestId('unavailable-refresh')).toBeInTheDocument();
  });
});

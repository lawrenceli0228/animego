import { render, screen } from '@testing-library/react';
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
    pickFolder: vi.fn(),
    reauthorize: vi.fn(),
    dropFolder: vi.fn(),
    selectFileByName: vi.fn(),
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

  it('shows empty state when IDB is empty and FSA is supported', async () => {
    renderPage();
    expect(await screen.findByRole('button', { name: /add folder/i })).toBeInTheDocument();
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
});

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import AnimeDetailPage from '../pages/AnimeDetailPage';

const mockUseAnimeDetail = vi.fn();
vi.mock('../hooks/useAnime', () => ({
  useAnimeDetail: (...args) => mockUseAnimeDetail(...args),
}));

vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({
    t: (key) => ({
      'anime.loadError': 'Load error',
      'detail.openPlayer': 'Play',
      'detail.openPlayerAria': 'Open player',
      'detail.linkCopied': 'Copied',
      'social.share': 'Share',
      'torrent.download': 'Download',
    }[key] || key),
    lang: 'en',
  }),
}));

vi.mock('../utils/formatters', () => ({
  pickTitle: (a) => a.titleNative || a.titleRomaji || 'Untitled',
}));

vi.mock('../components/anime/AnimeDetailHero', () => ({
  default: ({ anime }) => <div data-testid="hero">{anime.anilistId}</div>,
}));

vi.mock('../components/subscription/SubscriptionButton', () => ({
  default: () => <div data-testid="subscription-button" />,
}));

vi.mock('../components/anime/WatchersAvatarList', () => ({
  default: () => <div data-testid="watchers" />,
}));

vi.mock('../components/anime/EpisodeList', () => ({
  default: () => <div data-testid="episode-list" />,
}));

vi.mock('../components/anime/CharacterSection', () => ({
  default: () => <div data-testid="characters" />,
}));

vi.mock('../components/anime/StaffSection', () => ({
  default: () => <div data-testid="staff" />,
}));

vi.mock('../components/anime/RelationSection', () => ({
  default: () => <div data-testid="relations" />,
}));

vi.mock('../components/anime/RecommendationSection', () => ({
  default: () => <div data-testid="recommendations" />,
}));

vi.mock('../components/anime/TorrentModal', () => ({
  default: ({ onClose }) => (
    <div data-testid="torrent-modal">
      <button onClick={onClose}>Close</button>
    </div>
  ),
}));

vi.mock('../components/common/Skeleton', () => ({
  DetailSkeleton: () => <div data-testid="detail-skeleton" />,
}));

function renderDetail(id = '42') {
  return render(
    <MemoryRouter initialEntries={[`/anime/${id}`]}>
      <Routes>
        <Route path="/anime/:id" element={<AnimeDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  mockUseAnimeDetail.mockReset();
  document.title = 'AnimeGo';
});

describe('AnimeDetailPage — states', () => {
  it('renders the skeleton while loading', () => {
    mockUseAnimeDetail.mockReturnValue({ data: null, isLoading: true, error: null });
    renderDetail();
    expect(screen.getByTestId('detail-skeleton')).toBeInTheDocument();
  });

  it('renders the error message on error', () => {
    mockUseAnimeDetail.mockReturnValue({
      data: null, isLoading: false, error: new Error('boom'),
    });
    renderDetail();
    expect(screen.getByText(/Load error/)).toBeInTheDocument();
    expect(screen.getByText(/boom/)).toBeInTheDocument();
  });

  it('renders nothing (empty body) when not loading and no data', () => {
    mockUseAnimeDetail.mockReturnValue({ data: null, isLoading: false, error: null });
    const { container } = renderDetail();
    expect(container.firstChild).toBeNull();
  });
});

describe('AnimeDetailPage — loaded state', () => {
  const anime = {
    anilistId: 42,
    titleNative: 'サンプル',
    titleRomaji: 'Sample',
    episodes: 12,
    relations: [],
    characters: [],
    staff: [],
    recommendations: [],
  };

  beforeEach(() => {
    mockUseAnimeDetail.mockReturnValue({ data: anime, isLoading: false, error: null });
  });

  it('passes the URL :id param to useAnimeDetail', () => {
    renderDetail('123');
    expect(mockUseAnimeDetail).toHaveBeenCalledWith('123');
  });

  it('renders all sections when data is available', () => {
    renderDetail();
    expect(screen.getByTestId('hero')).toHaveTextContent('42');
    expect(screen.getByTestId('subscription-button')).toBeInTheDocument();
    expect(screen.getByTestId('watchers')).toBeInTheDocument();
    expect(screen.getByTestId('relations')).toBeInTheDocument();
    expect(screen.getByTestId('characters')).toBeInTheDocument();
    expect(screen.getByTestId('staff')).toBeInTheDocument();
    expect(screen.getByTestId('episode-list')).toBeInTheDocument();
    expect(screen.getByTestId('recommendations')).toBeInTheDocument();
  });

  it('updates document.title with the native title', async () => {
    renderDetail();
    await waitFor(() => {
      expect(document.title).toBe('サンプル — AnimeGo');
    });
  });

  it('shows download and play buttons when anime has episodes', () => {
    renderDetail();
    expect(screen.getByText('Download')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open player' })).toBeInTheDocument();
  });

  it('hides download and play buttons when anime has zero episodes', () => {
    mockUseAnimeDetail.mockReturnValue({
      data: { ...anime, episodes: 0 },
      isLoading: false,
      error: null,
    });
    renderDetail();
    expect(screen.queryByText('Download')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open player' })).not.toBeInTheDocument();
  });

  it('opens the torrent modal when the download button is clicked', () => {
    renderDetail();
    expect(screen.queryByTestId('torrent-modal')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Download'));

    expect(screen.getByTestId('torrent-modal')).toBeInTheDocument();
  });

  it('closes the torrent modal when onClose fires', () => {
    renderDetail();
    fireEvent.click(screen.getByText('Download'));
    expect(screen.getByTestId('torrent-modal')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Close'));

    expect(screen.queryByTestId('torrent-modal')).not.toBeInTheDocument();
  });

  it('opens /player in a new tab when play is clicked', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderDetail();

    fireEvent.click(screen.getByRole('button', { name: 'Open player' }));

    expect(openSpy).toHaveBeenCalledWith('/player', '_blank', 'noopener,noreferrer');
    openSpy.mockRestore();
  });
});

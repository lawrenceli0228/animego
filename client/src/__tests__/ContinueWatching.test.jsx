import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ContinueWatching from '../components/anime/ContinueWatching';

const mockUseAuth = vi.fn();
const mockUseSubscriptions = vi.fn();

vi.mock('../context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}));

vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({
    t: (key) => ({
      'home.continueLabel': 'CONTINUE',
      'home.watchingTitle': 'Keep watching',
      'detail.epUnit': 'ep',
      'sub.watching': 'Watching',
    }[key] || key),
    lang: 'en',
  }),
}));

vi.mock('../hooks/useSubscription', () => ({
  useSubscriptions: (...args) => mockUseSubscriptions(...args),
}));

vi.mock('../utils/formatters', () => ({
  pickTitle: (a) => a.titleRomaji || 'Untitled',
}));

function renderCw() {
  return render(
    <MemoryRouter>
      <ContinueWatching />
    </MemoryRouter>
  );
}

beforeEach(() => {
  mockUseAuth.mockReset();
  mockUseSubscriptions.mockReset();
});

describe('ContinueWatching', () => {
  it('renders nothing when user is not logged in', () => {
    mockUseAuth.mockReturnValue({ user: null });
    mockUseSubscriptions.mockReturnValue({ data: [], isLoading: false });
    const { container } = renderCw();
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing while loading', () => {
    mockUseAuth.mockReturnValue({ user: { _id: 'u1' } });
    mockUseSubscriptions.mockReturnValue({ data: null, isLoading: true });
    const { container } = renderCw();
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when watching list is empty', () => {
    mockUseAuth.mockReturnValue({ user: { _id: 'u1' } });
    mockUseSubscriptions.mockReturnValue({ data: [], isLoading: false });
    const { container } = renderCw();
    expect(container.firstChild).toBeNull();
  });

  it('requests subscriptions with status=watching', () => {
    mockUseAuth.mockReturnValue({ user: { _id: 'u1' } });
    mockUseSubscriptions.mockReturnValue({ data: [], isLoading: false });
    renderCw();
    expect(mockUseSubscriptions).toHaveBeenCalledWith('watching');
  });

  it('renders a card per subscription with link to detail page', () => {
    mockUseAuth.mockReturnValue({ user: { _id: 'u1' } });
    mockUseSubscriptions.mockReturnValue({
      data: [
        { anilistId: 1, titleRomaji: 'A', coverImageUrl: 'a.jpg', currentEpisode: 3, episodes: 12 },
        { anilistId: 2, titleRomaji: 'B', coverImageUrl: 'b.jpg', currentEpisode: 0, episodes: 0 },
      ],
      isLoading: false,
    });
    renderCw();
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('B')).toBeInTheDocument();
    const links = screen.getAllByRole('link');
    expect(links[0]).toHaveAttribute('href', '/anime/1');
    expect(links[1]).toHaveAttribute('href', '/anime/2');
  });

  it('shows "current/total ep" badge when currentEpisode > 0', () => {
    mockUseAuth.mockReturnValue({ user: { _id: 'u1' } });
    mockUseSubscriptions.mockReturnValue({
      data: [{ anilistId: 1, titleRomaji: 'A', coverImageUrl: 'x', currentEpisode: 5, episodes: 12 }],
      isLoading: false,
    });
    renderCw();
    expect(screen.getByText(/5\/12 ep/)).toBeInTheDocument();
  });

  it('shows "total ep" when currentEpisode=0 and episodes known', () => {
    mockUseAuth.mockReturnValue({ user: { _id: 'u1' } });
    mockUseSubscriptions.mockReturnValue({
      data: [{ anilistId: 1, titleRomaji: 'A', coverImageUrl: 'x', currentEpisode: 0, episodes: 12 }],
      isLoading: false,
    });
    renderCw();
    expect(screen.getByText(/^12 ep/)).toBeInTheDocument();
  });

  it('falls back to Watching label when both values are 0', () => {
    mockUseAuth.mockReturnValue({ user: { _id: 'u1' } });
    mockUseSubscriptions.mockReturnValue({
      data: [{ anilistId: 1, titleRomaji: 'A', coverImageUrl: 'x', currentEpisode: 0, episodes: 0 }],
      isLoading: false,
    });
    renderCw();
    expect(screen.getByText('Watching')).toBeInTheDocument();
  });

  it('renders a progress bar when episodes > 0', () => {
    mockUseAuth.mockReturnValue({ user: { _id: 'u1' } });
    mockUseSubscriptions.mockReturnValue({
      data: [{ anilistId: 1, titleRomaji: 'A', coverImageUrl: 'x', currentEpisode: 6, episodes: 12 }],
      isLoading: false,
    });
    const { container } = renderCw();
    // Progress bar inner has width in percentage form
    const progressInner = container.querySelector('div[style*="width: 50%"]');
    expect(progressInner).toBeInTheDocument();
  });

  it('caps progress at 100% when currentEpisode > episodes', () => {
    mockUseAuth.mockReturnValue({ user: { _id: 'u1' } });
    mockUseSubscriptions.mockReturnValue({
      data: [{ anilistId: 1, titleRomaji: 'A', coverImageUrl: 'x', currentEpisode: 99, episodes: 12 }],
      isLoading: false,
    });
    const { container } = renderCw();
    expect(container.querySelector('div[style*="width: 100%"]')).toBeInTheDocument();
  });
});

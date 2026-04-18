import { render, screen } from '@testing-library/react';
import HomePage from '../pages/HomePage';

const mockUseSeasonalAnime = vi.fn();

vi.mock('../hooks/useAnime', () => ({
  useSeasonalAnime: (...args) => mockUseSeasonalAnime(...args),
}));

vi.mock('../utils/constants', () => ({
  getCurrentSeason: () => 'SPRING',
}));

vi.mock('../components/anime/HeroCarousel', () => ({
  default: ({ animeList }) => (
    <div data-testid="hero-carousel">items:{animeList.length}</div>
  ),
}));

vi.mock('../components/home/TrendingSection', () => ({
  default: () => <div data-testid="trending-section" />,
}));

vi.mock('../components/home/SeasonRankings', () => ({
  default: () => <div data-testid="season-rankings" />,
}));

vi.mock('../components/anime/ContinueWatching', () => ({
  default: () => <div data-testid="continue-watching" />,
}));

vi.mock('../components/home/CompletedGems', () => ({
  default: () => <div data-testid="completed-gems" />,
}));

vi.mock('../components/social/ActivityFeed', () => ({
  default: () => <div data-testid="activity-feed" />,
}));

vi.mock('../components/anime/WeeklySchedule', () => ({
  default: () => <div data-testid="weekly-schedule" />,
}));

beforeEach(() => {
  mockUseSeasonalAnime.mockReset();
});

describe('HomePage', () => {
  it('requests seasonal anime for current season and year', () => {
    mockUseSeasonalAnime.mockReturnValue({ data: { data: [] }, isLoading: false });
    render(<HomePage />);

    const [season, year, page] = mockUseSeasonalAnime.mock.calls[0];
    expect(season).toBe('SPRING');
    expect(year).toBe(new Date().getFullYear());
    expect(page).toBe(1);
  });

  it('renders a skeleton hero while seasonal data is loading', () => {
    mockUseSeasonalAnime.mockReturnValue({ data: null, isLoading: true });
    const { container } = render(<HomePage />);

    expect(screen.queryByTestId('hero-carousel')).not.toBeInTheDocument();
    // The skeleton uses shimmer keyframe blocks — check the shimmer style was injected
    expect(container.innerHTML).toContain('shimmer');
  });

  it('renders HeroCarousel with top 5 anime once loaded', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ anilistId: i + 1 }));
    mockUseSeasonalAnime.mockReturnValue({ data: { data: items }, isLoading: false });
    render(<HomePage />);

    expect(screen.getByTestId('hero-carousel')).toHaveTextContent('items:5');
  });

  it('renders all home sections below the hero', () => {
    mockUseSeasonalAnime.mockReturnValue({ data: { data: [] }, isLoading: false });
    render(<HomePage />);

    expect(screen.getByTestId('trending-section')).toBeInTheDocument();
    expect(screen.getByTestId('continue-watching')).toBeInTheDocument();
    expect(screen.getByTestId('weekly-schedule')).toBeInTheDocument();
    expect(screen.getByTestId('completed-gems')).toBeInTheDocument();
    expect(screen.getByTestId('activity-feed')).toBeInTheDocument();
    expect(screen.getByTestId('season-rankings')).toBeInTheDocument();
  });

  it('handles empty seasonal data gracefully (HeroCarousel gets empty list)', () => {
    mockUseSeasonalAnime.mockReturnValue({ data: null, isLoading: false });
    render(<HomePage />);

    expect(screen.getByTestId('hero-carousel')).toHaveTextContent('items:0');
  });
});

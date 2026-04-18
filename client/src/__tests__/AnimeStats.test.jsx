import { render, screen } from '@testing-library/react';
import AnimeStats from '../components/profile/AnimeStats';

const mockUseSubs = vi.fn();
let lang = 'en';

vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({ lang }),
}));

vi.mock('../hooks/useSubscription', () => ({
  useSubscriptions: () => mockUseSubs(),
}));

beforeEach(() => {
  mockUseSubs.mockReset();
  lang = 'en';
});

describe('AnimeStats', () => {
  it('renders nothing while loading', () => {
    mockUseSubs.mockReturnValue({ data: null, isLoading: true });
    const { container } = render(<AnimeStats />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when subs is empty', () => {
    mockUseSubs.mockReturnValue({ data: [], isLoading: false });
    const { container } = render(<AnimeStats />);
    expect(container.firstChild).toBeNull();
  });

  it('renders donut center with total count', () => {
    mockUseSubs.mockReturnValue({
      data: [
        { status: 'watching' },
        { status: 'completed' },
        { status: 'completed' },
      ],
      isLoading: false,
    });
    render(<AnimeStats />);
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('shows status labels with counts for nonzero entries only', () => {
    mockUseSubs.mockReturnValue({
      data: [{ status: 'watching' }, { status: 'completed' }, { status: 'completed' }],
      isLoading: false,
    });
    render(<AnimeStats />);
    expect(screen.getByText('Watching')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.queryByText('Plan')).not.toBeInTheDocument();
    expect(screen.queryByText('Dropped')).not.toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('renders top 3 genres based on frequency', () => {
    mockUseSubs.mockReturnValue({
      data: [
        { status: 'watching', genres: ['Action','Drama','Comedy','Sci-Fi'] },
        { status: 'watching', genres: ['Action','Drama'] },
        { status: 'watching', genres: ['Action','Comedy'] },
      ],
      isLoading: false,
    });
    render(<AnimeStats />);
    expect(screen.getByText('Action')).toBeInTheDocument();
    expect(screen.getByText('Drama')).toBeInTheDocument();
    expect(screen.getByText('Comedy')).toBeInTheDocument();
    expect(screen.queryByText('Sci-Fi')).not.toBeInTheDocument();
    expect(screen.getByText('Top Genres')).toBeInTheDocument();
  });

  it('renders most active season text from year+season', () => {
    mockUseSubs.mockReturnValue({
      data: [
        { status: 'watching', season: 'SPRING', seasonYear: 2024 },
        { status: 'watching', season: 'SPRING', seasonYear: 2024 },
        { status: 'watching', season: 'FALL', seasonYear: 2023 },
      ],
      isLoading: false,
    });
    render(<AnimeStats />);
    expect(screen.getByText('2024 Spring')).toBeInTheDocument();
    expect(screen.getByText('Most Active Season')).toBeInTheDocument();
  });

  it('uses Chinese labels when lang=zh', () => {
    lang = 'zh';
    mockUseSubs.mockReturnValue({
      data: [{ status: 'watching', genres: ['Action'], season: 'SPRING', seasonYear: 2024 }],
      isLoading: false,
    });
    render(<AnimeStats />);
    expect(screen.getByText('在看')).toBeInTheDocument();
    expect(screen.getByText('常追类型')).toBeInTheDocument();
    expect(screen.getByText('最活跃赛季')).toBeInTheDocument();
    expect(screen.getByText('2024 春季')).toBeInTheDocument();
  });

  it('omits genre section when no genres provided', () => {
    mockUseSubs.mockReturnValue({
      data: [{ status: 'watching' }],
      isLoading: false,
    });
    render(<AnimeStats />);
    expect(screen.queryByText('Top Genres')).not.toBeInTheDocument();
  });

  it('omits season section when no season data', () => {
    mockUseSubs.mockReturnValue({
      data: [{ status: 'watching' }],
      isLoading: false,
    });
    render(<AnimeStats />);
    expect(screen.queryByText('Most Active Season')).not.toBeInTheDocument();
  });
});

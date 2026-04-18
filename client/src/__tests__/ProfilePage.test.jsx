import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import ProfilePage from '../pages/ProfilePage';

const mockUseAuth = vi.fn();
const mockUseSubs = vi.fn();

vi.mock('../context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}));

vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({
    t: (k) => ({
      'profile.label': 'PROFILE',
      'profile.titleSuffix': "'s list",
      'profile.noAnime': 'No anime in',
      'profile.noAnimeSuffix': 'yet',
      'sub.watching': 'Watching',
      'sub.completed': 'Completed',
      'sub.planToWatch': 'Plan',
      'sub.dropped': 'Dropped',
    }[k] || k),
    lang: 'en',
  }),
}));

vi.mock('../hooks/useSubscription', () => ({
  useSubscriptions: (...args) => mockUseSubs(...args),
}));

vi.mock('../utils/constants', () => ({
  STATUS_OPTIONS: [
    { value: 'watching', color: '#0a84ff' },
    { value: 'completed', color: '#30d158' },
    { value: 'plan_to_watch', color: '#ff9f0a' },
    { value: 'dropped', color: '#ff453a' },
  ],
}));

vi.mock('../utils/formatters', () => ({
  pickTitle: (a) => a.titleRomaji || 'Untitled',
  formatScore: (s) => String(s),
}));

vi.mock('../components/common/Skeleton', () => ({
  ProfileListSkeleton: () => <div data-testid="skeleton">skel</div>,
}));

vi.mock('../components/profile/AnimeStats', () => ({
  default: () => <div data-testid="stats">stats</div>,
}));

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

function renderPp() {
  return render(
    <MemoryRouter>
      <ProfilePage />
      <Routes>
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  mockUseAuth.mockReset();
  mockUseSubs.mockReset();
  mockUseAuth.mockReturnValue({ user: { username: 'alice' } });
});

describe('ProfilePage', () => {
  it('renders title with username', () => {
    mockUseSubs.mockReturnValue({ data: [], isLoading: false });
    renderPp();
    expect(screen.getByText(/alice'?s list/)).toBeInTheDocument();
  });

  it('shows skeleton while loading', () => {
    mockUseSubs.mockReturnValue({ data: null, isLoading: true });
    renderPp();
    expect(screen.getByTestId('skeleton')).toBeInTheDocument();
  });

  it('requests "watching" by default', () => {
    mockUseSubs.mockReturnValue({ data: [], isLoading: false });
    renderPp();
    expect(mockUseSubs).toHaveBeenCalledWith('watching');
  });

  it('switches status on tab click', () => {
    mockUseSubs.mockReturnValue({ data: [], isLoading: false });
    renderPp();
    fireEvent.click(screen.getByText('Completed'));
    expect(mockUseSubs).toHaveBeenLastCalledWith('completed');
  });

  it('shows no-anime message when list empty without search', () => {
    mockUseSubs.mockReturnValue({ data: [], isLoading: false });
    renderPp();
    expect(screen.getByText(/No anime in/)).toBeInTheDocument();
  });

  it('filters by search text', () => {
    mockUseSubs.mockReturnValue({
      data: [
        { anilistId: 1, titleRomaji: 'Naruto', coverImageUrl: 'x', averageScore: 80 },
        { anilistId: 2, titleRomaji: 'Bleach', coverImageUrl: 'x', averageScore: 70 },
      ],
      isLoading: false,
    });
    renderPp();
    const input = screen.getByPlaceholderText('Search my list...');
    fireEvent.change(input, { target: { value: 'naru' } });
    expect(screen.getByText('Naruto')).toBeInTheDocument();
    expect(screen.queryByText('Bleach')).not.toBeInTheDocument();
  });

  it('navigates to /anime/:id on card click', () => {
    mockUseSubs.mockReturnValue({
      data: [{ anilistId: 42, titleRomaji: 'X', coverImageUrl: 'x' }],
      isLoading: false,
    });
    renderPp();
    fireEvent.click(screen.getByText('X'));
    expect(screen.getByTestId('loc').textContent).toBe('/anime/42');
  });

  it('shows "No matches" when search filters everything out', () => {
    mockUseSubs.mockReturnValue({
      data: [{ anilistId: 1, titleRomaji: 'Naruto', coverImageUrl: 'x' }],
      isLoading: false,
    });
    renderPp();
    fireEvent.change(screen.getByPlaceholderText('Search my list...'), { target: { value: 'xyz' } });
    expect(screen.getByText('No matches')).toBeInTheDocument();
  });

  it('shows count badge next to active tab', () => {
    mockUseSubs.mockReturnValue({ data: [{ anilistId: 1, titleRomaji: 'A' }], isLoading: false });
    renderPp();
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('shows star score when averageScore present', () => {
    mockUseSubs.mockReturnValue({
      data: [{ anilistId: 1, titleRomaji: 'A', coverImageUrl: 'x', averageScore: 88 }],
      isLoading: false,
    });
    renderPp();
    expect(screen.getByText(/★ 88/)).toBeInTheDocument();
  });

  it('shows my score in "Me: N/10" format', () => {
    mockUseSubs.mockReturnValue({
      data: [{ anilistId: 1, titleRomaji: 'A', coverImageUrl: 'x', score: 9 }],
      isLoading: false,
    });
    renderPp();
    expect(screen.getByText(/Me: 9\/10/)).toBeInTheDocument();
  });

  it('shows current episode when > 0', () => {
    mockUseSubs.mockReturnValue({
      data: [{ anilistId: 1, titleRomaji: 'A', coverImageUrl: 'x', currentEpisode: 5, episodes: 12 }],
      isLoading: false,
    });
    renderPp();
    expect(screen.getByText(/Ep 5.*12/)).toBeInTheDocument();
  });
});

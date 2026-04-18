import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CompletedGems from '../components/home/CompletedGems';

const mockUseGems = vi.fn();
const mockInvalidate = vi.fn();

vi.mock('../hooks/useAnime', () => ({
  useCompletedGems: (...args) => mockUseGems(...args),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mockInvalidate }),
}));

vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({
    t: (k) => ({
      'home.gemsLabel': 'GEMS',
      'home.gemsTitle': 'Hidden Gems',
      'home.gemsRefresh': 'Refresh',
      'detail.epUnit': 'ep',
    }[k] || k),
    lang: 'en',
  }),
}));

vi.mock('../utils/formatters', () => ({
  pickTitle: (a) => a.titleRomaji || 'Untitled',
  formatScore: (s) => String(s),
}));

function renderCg() {
  return render(<MemoryRouter><CompletedGems /></MemoryRouter>);
}

beforeEach(() => {
  mockUseGems.mockReset();
  mockInvalidate.mockReset();
});

describe('CompletedGems', () => {
  it('renders nothing on error', () => {
    mockUseGems.mockReturnValue({ data: null, isLoading: false, isError: true });
    const { container } = renderCg();
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when data is empty', () => {
    mockUseGems.mockReturnValue({ data: [], isLoading: false, isError: false });
    const { container } = renderCg();
    expect(container.firstChild).toBeNull();
  });

  it('renders loading skeletons without refresh button', () => {
    mockUseGems.mockReturnValue({ data: null, isLoading: true, isError: false });
    renderCg();
    expect(screen.getByText('Hidden Gems')).toBeInTheDocument();
    expect(screen.queryByText('Refresh')).not.toBeInTheDocument();
  });

  it('renders list of cards with titles', () => {
    mockUseGems.mockReturnValue({
      data: [
        { anilistId: 1, titleRomaji: 'A', coverImageUrl: 'a', averageScore: 85, episodes: 12, genres: ['g1','g2'] },
        { anilistId: 2, titleRomaji: 'B', coverImageUrl: 'b', averageScore: 0, episodes: 0, genres: [] },
      ],
      isLoading: false, isError: false,
    });
    renderCg();
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('B')).toBeInTheDocument();
  });

  it('shows score badge when averageScore > 0', () => {
    mockUseGems.mockReturnValue({
      data: [{ anilistId: 1, titleRomaji: 'A', coverImageUrl: '', averageScore: 82, episodes: 12 }],
      isLoading: false, isError: false,
    });
    renderCg();
    expect(screen.getByText('82')).toBeInTheDocument();
  });

  it('shows episode badge when episodes > 0', () => {
    mockUseGems.mockReturnValue({
      data: [{ anilistId: 1, titleRomaji: 'A', coverImageUrl: '', averageScore: 0, episodes: 12 }],
      isLoading: false, isError: false,
    });
    renderCg();
    expect(screen.getByText(/12ep/)).toBeInTheDocument();
  });

  it('joins up to 3 genres', () => {
    mockUseGems.mockReturnValue({
      data: [{ anilistId: 1, titleRomaji: 'A', coverImageUrl: '', averageScore: 0, episodes: 0, genres: ['a','b','c','d'] }],
      isLoading: false, isError: false,
    });
    renderCg();
    expect(screen.getByText('a / b / c')).toBeInTheDocument();
  });

  it('calls invalidateQueries when refresh clicked', () => {
    mockUseGems.mockReturnValue({
      data: [{ anilistId: 1, titleRomaji: 'A', coverImageUrl: '', averageScore: 0 }],
      isLoading: false, isError: false,
    });
    renderCg();
    fireEvent.click(screen.getByText('Refresh'));
    expect(mockInvalidate).toHaveBeenCalledWith({ queryKey: ['completedGems'] });
  });

  it('requests 10 items', () => {
    mockUseGems.mockReturnValue({ data: [], isLoading: false, isError: false });
    renderCg();
    expect(mockUseGems).toHaveBeenCalledWith(10);
  });
});

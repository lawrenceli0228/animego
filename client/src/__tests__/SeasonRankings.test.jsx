import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SeasonRankings from '../components/home/SeasonRankings';

const mockUseYT = vi.fn();

vi.mock('../hooks/useAnime', () => ({
  useYearlyTop: (...args) => mockUseYT(...args),
}));

vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({
    t: (k) => ({
      'home.rankingsLabel': 'RANKINGS',
      'home.rankingsTitle': 'Top Yearly',
      'detail.epUnit': 'ep',
    }[k] || k),
    lang: 'en',
  }),
}));

vi.mock('../utils/formatters', () => ({
  pickTitle: (a) => a.titleRomaji || 'Untitled',
  formatScore: (s) => String(s),
}));

function renderSr() {
  return render(<MemoryRouter><SeasonRankings /></MemoryRouter>);
}

beforeEach(() => mockUseYT.mockReset());

describe('SeasonRankings', () => {
  it('renders nothing when data empty and not loading', () => {
    mockUseYT.mockReturnValue({ data: [], isLoading: false });
    const { container } = renderSr();
    expect(container.firstChild).toBeNull();
  });

  it('renders skeletons when loading', () => {
    mockUseYT.mockReturnValue({ data: undefined, isLoading: true });
    renderSr();
    expect(screen.getByText('Top Yearly')).toBeInTheDocument();
  });

  it('renders ranked list with numbers 1..N', () => {
    mockUseYT.mockReturnValue({
      data: [
        { anilistId: 1, titleRomaji: 'One', coverImageUrl: 'c', averageScore: 90, episodes: 12, genres: ['g1','g2','g3'] },
        { anilistId: 2, titleRomaji: 'Two', coverImageUrl: 'c', averageScore: 0, episodes: 0, genres: [] },
      ],
      isLoading: false,
    });
    renderSr();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('One')).toBeInTheDocument();
    expect(screen.getByText('Two')).toBeInTheDocument();
  });

  it('joins first two genres with · separator', () => {
    mockUseYT.mockReturnValue({
      data: [{ anilistId: 1, titleRomaji: 'A', coverImageUrl: '', averageScore: 0, episodes: 0, genres: ['a','b','c'] }],
      isLoading: false,
    });
    renderSr();
    expect(screen.getByText(/a · b/)).toBeInTheDocument();
  });

  it('appends episode count when > 0', () => {
    mockUseYT.mockReturnValue({
      data: [{ anilistId: 1, titleRomaji: 'A', coverImageUrl: '', averageScore: 0, episodes: 12, genres: ['x'] }],
      isLoading: false,
    });
    renderSr();
    expect(screen.getByText(/12 ep/)).toBeInTheDocument();
  });

  it('shows score only when averageScore > 0', () => {
    mockUseYT.mockReturnValue({
      data: [
        { anilistId: 1, titleRomaji: 'A', coverImageUrl: '', averageScore: 88, episodes: 0 },
        { anilistId: 2, titleRomaji: 'B', coverImageUrl: '', averageScore: 0, episodes: 0 },
      ],
      isLoading: false,
    });
    renderSr();
    expect(screen.getByText('88')).toBeInTheDocument();
  });

  it('links to /anime/:id', () => {
    mockUseYT.mockReturnValue({
      data: [{ anilistId: 42, titleRomaji: 'A', coverImageUrl: '', averageScore: 0, episodes: 0 }],
      isLoading: false,
    });
    renderSr();
    expect(screen.getByRole('link')).toHaveAttribute('href', '/anime/42');
  });

  it('requests current year with limit 10', () => {
    mockUseYT.mockReturnValue({ data: [], isLoading: false });
    renderSr();
    const year = new Date().getFullYear();
    expect(mockUseYT).toHaveBeenCalledWith(year, 10);
  });
});

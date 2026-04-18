import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SeasonPage from '../pages/SeasonPage';

const mockUseSeasonal = vi.fn();
let lang = 'en';

vi.mock('../hooks/useAnime', () => ({
  useSeasonalAnime: (...args) => mockUseSeasonal(...args),
}));

vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({ t: (k) => k, lang }),
}));

vi.mock('../utils/constants', () => ({
  getCurrentSeason: () => 'SPRING',
}));

vi.mock('../utils/formatters', () => ({
  pickTitle: (a) => a.titleRomaji || 'Untitled',
}));

vi.mock('../components/season/SeasonSelector', () => ({
  default: ({ year, season, onYearChange, onSeasonChange }) => (
    <div data-testid="sel">
      <button onClick={() => onYearChange(2020)}>year</button>
      <button onClick={() => onSeasonChange('FALL')}>season</button>
      <span>{year}/{season}</span>
    </div>
  ),
}));

vi.mock('../components/search/GenreFilter', () => ({
  default: ({ selected, onSelect }) => (
    <button data-testid="genre" onClick={() => onSelect('Action')}>{selected || 'none'}</button>
  ),
}));

vi.mock('../components/anime/AnimeGrid', () => ({
  default: ({ animeList, loading }) => (
    <div data-testid="grid">{loading ? 'loading' : `n=${animeList?.length ?? 0}`}</div>
  ),
}));

function renderSp(path = '/season') {
  return render(<MemoryRouter initialEntries={[path]}><SeasonPage /></MemoryRouter>);
}

beforeEach(() => {
  mockUseSeasonal.mockReset();
  lang = 'en';
});

describe('SeasonPage', () => {
  it('calls useSeasonalAnime with default season when no params', () => {
    mockUseSeasonal.mockReturnValue({ data: null, isLoading: true, error: null });
    renderSp();
    const year = new Date().getFullYear();
    expect(mockUseSeasonal).toHaveBeenCalledWith('SPRING', year, 1, 200);
  });

  it('reads season and year from URL params', () => {
    mockUseSeasonal.mockReturnValue({ data: null, isLoading: true, error: null });
    renderSp('/season?season=FALL&year=2022');
    expect(mockUseSeasonal).toHaveBeenCalledWith('FALL', 2022, 1, 200);
  });

  it('renders grid with initial 20 items cap', () => {
    const list = Array.from({ length: 30 }, (_, i) => ({ anilistId: i + 1, titleRomaji: `A${i}`, genres: [], format: 'TV', status: 'RELEASING', averageScore: i }));
    mockUseSeasonal.mockReturnValue({ data: { data: list }, isLoading: false, error: null });
    renderSp();
    expect(screen.getByTestId('grid').textContent).toBe('n=20');
  });

  it('shows "Show More" button when more items exist', () => {
    const list = Array.from({ length: 30 }, (_, i) => ({ anilistId: i + 1, titleRomaji: `A${i}`, format: 'TV', status: 'RELEASING' }));
    mockUseSeasonal.mockReturnValue({ data: { data: list }, isLoading: false, error: null });
    renderSp();
    expect(screen.getByText('Show More')).toBeInTheDocument();
  });

  it('loads more items on click', () => {
    const list = Array.from({ length: 50 }, (_, i) => ({ anilistId: i + 1, titleRomaji: `A${i}`, format: 'TV', status: 'RELEASING' }));
    mockUseSeasonal.mockReturnValue({ data: { data: list }, isLoading: false, error: null });
    renderSp();
    fireEvent.click(screen.getByText('Show More'));
    expect(screen.getByTestId('grid').textContent).toBe('n=40');
  });

  it('filters by genre', () => {
    const list = [
      { anilistId: 1, titleRomaji: 'A', genres: ['Action'], format: 'TV', status: 'RELEASING' },
      { anilistId: 2, titleRomaji: 'B', genres: ['Drama'], format: 'TV', status: 'RELEASING' },
    ];
    mockUseSeasonal.mockReturnValue({ data: { data: list }, isLoading: false, error: null });
    renderSp();
    fireEvent.click(screen.getByTestId('genre'));
    expect(screen.getByTestId('grid').textContent).toBe('n=1');
  });

  it('shows item count in English', () => {
    mockUseSeasonal.mockReturnValue({ data: { data: [{ anilistId: 1, titleRomaji: 'A', format: 'TV', status: 'RELEASING' }] }, isLoading: false, error: null });
    renderSp();
    expect(screen.getByText(/1 anime/)).toBeInTheDocument();
  });

  it('shows item count label in Chinese when lang=zh', () => {
    lang = 'zh';
    mockUseSeasonal.mockReturnValue({ data: { data: [{ anilistId: 1, titleRomaji: 'A', format: 'TV', status: 'RELEASING' }] }, isLoading: false, error: null });
    renderSp();
    expect(screen.getByText(/1 部/)).toBeInTheDocument();
  });
});

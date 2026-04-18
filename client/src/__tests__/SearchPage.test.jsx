import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SearchPage from '../pages/SearchPage';

const mockUseSearch = vi.fn();

vi.mock('../hooks/useAnime', () => ({
  useAnimeSearch: (...args) => mockUseSearch(...args),
}));

vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({ t: (k) => k, lang: 'en' }),
}));

vi.mock('../components/search/SearchBar', () => ({
  default: ({ value, onChange }) => (
    <input data-testid="searchbar" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

vi.mock('../components/search/GenreFilter', () => ({
  default: ({ selected, onSelect }) => (
    <button data-testid="genre" onClick={() => onSelect('Action')}>{selected || 'none'}</button>
  ),
}));

vi.mock('../components/anime/AnimeGrid', () => ({
  default: ({ animeList, loading, error }) => (
    <div data-testid="grid">{loading ? 'loading' : error ? 'error' : `n=${animeList?.length ?? 0}`}</div>
  ),
}));

vi.mock('../components/common/Pagination', () => ({
  default: ({ page, totalPages }) => <div data-testid="pagination">{page}/{totalPages ?? '-'}</div>,
}));

function renderSp(path = '/search') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SearchPage />
    </MemoryRouter>
  );
}

beforeEach(() => mockUseSearch.mockReset());

describe('SearchPage', () => {
  it('shows prompt when no query or genre', () => {
    mockUseSearch.mockReturnValue({ data: null, isLoading: false, error: null });
    renderSp();
    expect(screen.getByText('search.prompt')).toBeInTheDocument();
    expect(screen.queryByTestId('grid')).not.toBeInTheDocument();
  });

  it('renders grid and pagination when query present', () => {
    mockUseSearch.mockReturnValue({
      data: { data: [{ anilistId: 1 }, { anilistId: 2 }], pagination: { totalPages: 3 } },
      isLoading: false, error: null,
    });
    renderSp('/search?q=naruto');
    expect(screen.getByTestId('grid').textContent).toBe('n=2');
    expect(screen.getByTestId('pagination').textContent).toBe('1/3');
  });

  it('renders grid when only genre is present', () => {
    mockUseSearch.mockReturnValue({ data: { data: [], pagination: { totalPages: 0 } }, isLoading: false, error: null });
    renderSp('/search?genre=Action');
    expect(screen.getByTestId('grid')).toBeInTheDocument();
  });

  it('passes query params to useAnimeSearch', () => {
    mockUseSearch.mockReturnValue({ data: null, isLoading: true, error: null });
    renderSp('/search?q=term&genre=Drama');
    expect(mockUseSearch).toHaveBeenCalledWith('term', 'Drama', 1);
  });

  it('updates URL when search text changes', () => {
    mockUseSearch.mockReturnValue({ data: null, isLoading: false, error: null });
    renderSp();
    fireEvent.change(screen.getByTestId('searchbar'), { target: { value: 'new' } });
    // After change, next render should have q=new
    expect(mockUseSearch).toHaveBeenLastCalledWith('new', '', 1);
  });

  it('renders section title', () => {
    mockUseSearch.mockReturnValue({ data: null, isLoading: false, error: null });
    renderSp();
    expect(screen.getByText('search.title')).toBeInTheDocument();
  });
});

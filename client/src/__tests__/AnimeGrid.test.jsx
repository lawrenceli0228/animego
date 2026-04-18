import { render, screen } from '@testing-library/react';
import AnimeGrid from '../components/anime/AnimeGrid';

vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({
    t: (key) => ({
      'anime.loadError': 'Load error',
      'anime.noAnime': 'No anime',
    }[key] || key),
  }),
}));

vi.mock('../components/anime/AnimeCard', () => ({
  default: ({ anime }) => <div data-testid="card">{anime.anilistId}</div>,
}));

vi.mock('../components/common/Skeleton', () => ({
  AnimeGridSkeleton: () => <div data-testid="grid-skeleton" />,
}));

describe('AnimeGrid', () => {
  it('renders the grid skeleton while loading', () => {
    render(<AnimeGrid animeList={[]} loading={true} />);
    expect(screen.getByTestId('grid-skeleton')).toBeInTheDocument();
  });

  it('renders an error message with the error text', () => {
    render(<AnimeGrid animeList={null} error={new Error('network down')} />);
    expect(screen.getByText(/Load error/)).toBeInTheDocument();
    expect(screen.getByText(/network down/)).toBeInTheDocument();
  });

  it('renders empty state when animeList is empty', () => {
    render(<AnimeGrid animeList={[]} />);
    expect(screen.getByText('No anime')).toBeInTheDocument();
  });

  it('renders empty state when animeList is null', () => {
    render(<AnimeGrid animeList={null} />);
    expect(screen.getByText('No anime')).toBeInTheDocument();
  });

  it('renders a card for every anime in the list', () => {
    const list = [
      { anilistId: 1 },
      { anilistId: 2 },
      { anilistId: 3 },
    ];
    render(<AnimeGrid animeList={list} />);
    const cards = screen.getAllByTestId('card');
    expect(cards).toHaveLength(3);
    expect(cards.map(c => c.textContent)).toEqual(['1', '2', '3']);
  });
});

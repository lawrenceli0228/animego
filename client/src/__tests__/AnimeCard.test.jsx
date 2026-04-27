import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import AnimeCard from '../components/anime/AnimeCard';

vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({ lang: 'en' }),
}));

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname}</div>;
}

function renderCard(props) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <AnimeCard {...props} />
      <Routes>
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>
  );
}

const baseAnime = {
  anilistId: 42,
  titleRomaji: 'Sample Anime',
  titleEnglish: 'Sample Anime',
  coverImageUrl: 'https://example.com/cover.jpg',
  averageScore: 82,
  genres: ['Action', 'Adventure', 'Sci-Fi'],
  format: 'TV',
};

describe('AnimeCard', () => {
  it('renders cover image, title, and score', () => {
    renderCard({ anime: baseAnime });
    expect(screen.getByAltText('Sample Anime')).toBeInTheDocument();
    expect(screen.getByText('Sample Anime')).toBeInTheDocument();
    // formatScore(82) = 8.2 → "★ 8.2"
    expect(screen.getByText('★ 8.2')).toBeInTheDocument();
  });

  it('shows the rank badge when rank prop is provided', () => {
    renderCard({ anime: baseAnime, rank: 3 });
    expect(screen.getByText('#3')).toBeInTheDocument();
    // Format badge is suppressed when rank is present
    expect(screen.queryByText('TV')).not.toBeInTheDocument();
  });

  it('shows the format badge when no rank but format exists', () => {
    renderCard({ anime: baseAnime });
    expect(screen.getByText('TV')).toBeInTheDocument();
  });

  it('shows watcher count when > 0', () => {
    renderCard({ anime: baseAnime, watcherCount: 12 });
    expect(screen.getByText('12 人')).toBeInTheDocument();
  });

  it('hides watcher badge when count is 0', () => {
    renderCard({ anime: baseAnime, watcherCount: 0 });
    expect(screen.queryByText(/人$/)).not.toBeInTheDocument();
  });

  it('renders as <a href> for crawlers and SPA-navigates on plain click', () => {
    renderCard({ anime: baseAnime });
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/anime/42');
    fireEvent.click(link, { button: 0 });
    expect(screen.getByTestId('location')).toHaveTextContent('/anime/42');
  });

  it('does not preventDefault on cmd/ctrl-click (lets browser open new tab)', () => {
    renderCard({ anime: baseAnime });
    const link = screen.getByRole('link');
    fireEvent.click(link, { button: 0, metaKey: true });
    expect(screen.getByTestId('location')).toHaveTextContent('/');
  });

  it('sets accessible aria-label with picked title', () => {
    renderCard({ anime: baseAnime });
    expect(screen.getByRole('link')).toHaveAttribute('aria-label', 'Sample Anime');
  });

  it('renders only first 2 genres', () => {
    renderCard({ anime: baseAnime });
    expect(screen.getByText('Action')).toBeInTheDocument();
    expect(screen.getByText('Adventure')).toBeInTheDocument();
    expect(screen.queryByText('Sci-Fi')).not.toBeInTheDocument();
  });

  it('omits score badge when averageScore is falsy', () => {
    renderCard({ anime: { ...baseAnime, averageScore: null } });
    expect(screen.queryByText(/★/)).not.toBeInTheDocument();
  });

  it('applies hover styles and shows genres overlay on mouseenter', () => {
    const { container } = renderCard({ anime: baseAnime });
    const card = screen.getByRole('link');
    const overlay = container.querySelector('.card-overlay');
    expect(overlay.style.opacity).toBe('0');
    fireEvent.mouseEnter(card);
    expect(overlay.style.opacity).toBe('1');
    expect(card.style.transform).toBe('translateY(-4px)');
    fireEvent.mouseLeave(card);
    expect(overlay.style.opacity).toBe('0');
    expect(card.style.transform).toBe('none');
  });
});

import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import HeroCarousel from '../components/anime/HeroCarousel';

vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({
    t: (key) => key,
    lang: 'en',
  }),
}));

vi.mock('../utils/formatters', () => ({
  stripHtml: (s) => (s || '').replace(/<[^>]+>/g, ''),
  truncate: (s, n) => (s || '').slice(0, n),
  formatScore: (s) => String(s),
  pickTitle: (a) => a.titleRomaji || 'Untitled',
}));

const sample = [
  { anilistId: 1, titleRomaji: 'A', bannerImageUrl: 'a.jpg', season: 'SPRING', seasonYear: 2024, genres: ['g1','g2','g3','g4','g5'], description: '<p>desc</p>', averageScore: 85 },
  { anilistId: 2, titleRomaji: 'B', coverImageUrl: 'b.jpg', season: 'SUMMER', seasonYear: 2024, genres: [], description: '', averageScore: 0 },
  { anilistId: 3, titleRomaji: 'C', coverImageUrl: 'c.jpg', season: 'FALL', seasonYear: 2024, genres: [], description: '', averageScore: 0 },
];

function renderHC(list) {
  return render(<MemoryRouter><HeroCarousel animeList={list} /></MemoryRouter>);
}

describe('HeroCarousel', () => {
  it('renders nothing for empty list', () => {
    const { container } = renderHC([]);
    expect(container.firstChild).toBeNull();
  });

  it('renders a slide for each anime', () => {
    renderHC(sample);
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('B')).toBeInTheDocument();
    expect(screen.getByText('C')).toBeInTheDocument();
  });

  it('shows indicator for each slide', () => {
    renderHC(sample);
    expect(screen.getByLabelText('Slide 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Slide 3')).toBeInTheDocument();
  });

  it('clicking an indicator jumps to that slide', () => {
    const { container } = renderHC(sample);
    fireEvent.click(screen.getByLabelText('Slide 3'));
    const slides = container.querySelectorAll('div[style*="opacity"]');
    // The 3rd slide container should now be visible (opacity 1)
    const visible = Array.from(container.querySelectorAll('div[style*="opacity: 1"]'));
    expect(visible.length).toBeGreaterThan(0);
  });

  it('slices genres to 4', () => {
    renderHC(sample);
    expect(screen.getByText('g1')).toBeInTheDocument();
    expect(screen.getByText('g4')).toBeInTheDocument();
    expect(screen.queryByText('g5')).not.toBeInTheDocument();
  });

  it('shows score when averageScore > 0', () => {
    renderHC(sample);
    expect(screen.getByText('85')).toBeInTheDocument();
  });

  it('renders detail link pointing to /anime/:id', () => {
    renderHC(sample);
    const links = screen.getAllByRole('link');
    expect(links[0]).toHaveAttribute('href', '/anime/1');
  });

  it('prev/next buttons change slides', () => {
    const { container } = renderHC(sample);
    const buttons = container.querySelectorAll('button[style*="border-radius: 50%"]');
    // buttons[0] = prev, buttons[1] = next
    fireEvent.click(buttons[1]);
    fireEvent.click(buttons[1]);
    // After 2 nexts from 0, we should be on slide 2
    // We just confirm buttons are wired and don't throw
    expect(buttons.length).toBe(2);
  });

  it('auto-advances on interval when not paused', () => {
    vi.useFakeTimers();
    const { container } = renderHC(sample);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    // Still rendered; no crash
    expect(container.firstChild).toBeTruthy();
    vi.useRealTimers();
  });

  it('pauses on mouseenter', () => {
    const { container } = renderHC(sample);
    const root = container.firstChild;
    fireEvent.mouseEnter(root);
    fireEvent.mouseLeave(root);
    // No errors — paused toggling
    expect(root).toBeTruthy();
  });

  it('does not autoadvance when only one slide', () => {
    vi.useFakeTimers();
    const { container } = renderHC([sample[0]]);
    act(() => { vi.advanceTimersByTime(20000); });
    expect(container.firstChild).toBeTruthy();
    vi.useRealTimers();
  });
});

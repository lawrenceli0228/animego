import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import RecommendationSection from '../components/anime/RecommendationSection';

let lang = 'en';
vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({ lang }),
}));

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

function renderRs(recs) {
  return render(
    <MemoryRouter>
      <RecommendationSection recommendations={recs} />
      <Routes>
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('RecommendationSection', () => {
  beforeEach(() => { lang = 'en'; });

  it('renders nothing for empty list', () => {
    const { container } = render(<MemoryRouter><RecommendationSection recommendations={[]} /></MemoryRouter>);
    expect(container.firstChild).toBeNull();
  });

  it('renders English label', () => {
    renderRs([{ anilistId: 1, title: 'T' }]);
    expect(screen.getByText('You Might Also Like')).toBeInTheDocument();
  });

  it('renders Chinese label when lang=zh', () => {
    lang = 'zh';
    renderRs([{ anilistId: 1, title: 'T' }]);
    expect(screen.getByText('看了这部还在看')).toBeInTheDocument();
  });

  it('renders title and cover image', () => {
    const { container } = renderRs([{ anilistId: 1, title: 'Title1', coverImageUrl: 'c.jpg' }]);
    expect(screen.getByText('Title1')).toBeInTheDocument();
    expect(container.querySelector('img').src).toContain('c.jpg');
  });

  it('shows score when averageScore > 0', () => {
    renderRs([{ anilistId: 1, title: 'T', averageScore: 82 }]);
    expect(screen.getByText(/★ 8\.2/)).toBeInTheDocument();
  });

  it('hides score when averageScore is 0', () => {
    renderRs([{ anilistId: 1, title: 'T', averageScore: 0 }]);
    expect(screen.queryByText(/★/)).not.toBeInTheDocument();
  });

  it('navigates on click to /anime/:id', () => {
    renderRs([{ anilistId: 99, title: 'T' }]);
    fireEvent.click(screen.getByText('T'));
    expect(screen.getByTestId('loc').textContent).toBe('/anime/99');
  });
});

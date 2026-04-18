import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import RelationSection from '../components/anime/RelationSection';

let lang = 'en';
vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({ lang, t: (k) => k }),
}));

vi.mock('../utils/formatters', () => ({
  pickTitle: (a) => a.title || 'Untitled',
}));

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

function renderRs(rels) {
  return render(
    <MemoryRouter>
      <RelationSection relations={rels} />
      <Routes>
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('RelationSection', () => {
  beforeEach(() => { lang = 'en'; });

  it('renders nothing for empty list', () => {
    const { container } = render(<MemoryRouter><RelationSection relations={[]} /></MemoryRouter>);
    expect(container.firstChild).toBeNull();
  });

  it('renders header in English', () => {
    renderRs([{ anilistId: 1, relationType: 'SEQUEL', title: 'T' }]);
    expect(screen.getByText('Relations')).toBeInTheDocument();
  });

  it('renders Chinese header when lang=zh', () => {
    lang = 'zh';
    renderRs([{ anilistId: 1, relationType: 'SEQUEL', title: 'T' }]);
    expect(screen.getByText('关联作品')).toBeInTheDocument();
  });

  it('maps relation type to English label', () => {
    renderRs([{ anilistId: 1, relationType: 'PREQUEL', title: 'Pre' }]);
    expect(screen.getByText('Prequel')).toBeInTheDocument();
  });

  it('maps relation type to Chinese label when lang=zh', () => {
    lang = 'zh';
    renderRs([{ anilistId: 1, relationType: 'PREQUEL', title: 'Pre' }]);
    expect(screen.getByText('前传')).toBeInTheDocument();
  });

  it('prefers titleChinese when lang=zh', () => {
    lang = 'zh';
    renderRs([{ anilistId: 1, relationType: 'SEQUEL', title: 'Eng', titleChinese: '中文' }]);
    expect(screen.getByText('中文')).toBeInTheDocument();
  });

  it('uses title when lang=en even if titleChinese exists', () => {
    renderRs([{ anilistId: 1, relationType: 'SEQUEL', title: 'Eng', titleChinese: '中文' }]);
    expect(screen.getByText('Eng')).toBeInTheDocument();
    expect(screen.queryByText('中文')).not.toBeInTheDocument();
  });

  it('renders image when coverImageUrl provided', () => {
    const { container } = renderRs([{ anilistId: 1, relationType: 'SEQUEL', title: 'T', coverImageUrl: 't.jpg' }]);
    const img = container.querySelector('img');
    expect(img).toBeTruthy();
    expect(img.src).toContain('t.jpg');
  });

  it('shows N/A placeholder when no coverImageUrl', () => {
    renderRs([{ anilistId: 1, relationType: 'SEQUEL', title: 'T' }]);
    expect(screen.getByText('N/A')).toBeInTheDocument();
  });

  it('navigates on click', () => {
    renderRs([{ anilistId: 42, relationType: 'SEQUEL', title: 'T' }]);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByTestId('loc').textContent).toBe('/anime/42');
  });

  it('navigates on Enter key', () => {
    renderRs([{ anilistId: 42, relationType: 'SEQUEL', title: 'T' }]);
    fireEvent.keyDown(screen.getByRole('button'), { key: 'Enter' });
    expect(screen.getByTestId('loc').textContent).toBe('/anime/42');
  });

  it('sorts relations by ORDER (PREQUEL before SEQUEL before SIDE_STORY)', () => {
    renderRs([
      { anilistId: 3, relationType: 'SIDE_STORY', title: 'third' },
      { anilistId: 1, relationType: 'PREQUEL', title: 'first' },
      { anilistId: 2, relationType: 'SEQUEL', title: 'second' },
    ]);
    const labels = screen.getAllByText(/Prequel|Sequel|Side Story/);
    expect(labels[0].textContent).toBe('Prequel');
    expect(labels[1].textContent).toBe('Sequel');
    expect(labels[2].textContent).toBe('Side Story');
  });
});

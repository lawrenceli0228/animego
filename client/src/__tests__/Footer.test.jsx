import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Footer from '../components/layout/Footer';

vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({
    t: (key) => {
      if (key === 'footer.copyright') return '© {year} AnimeGo';
      // Convert "footer.abc" → "ABC" so keys are distinguishable in the DOM
      return key.replace(/^footer\./, '');
    },
  }),
}));

function renderFooter() {
  return render(
    <MemoryRouter>
      <Footer />
    </MemoryRouter>
  );
}

describe('Footer', () => {
  it('renders four column titles', () => {
    renderFooter();
    expect(screen.getByText('siteCol')).toBeInTheDocument();
    expect(screen.getByText('browseCol')).toBeInTheDocument();
    expect(screen.getByText('socialCol')).toBeInTheDocument();
    expect(screen.getByText('supportCol')).toBeInTheDocument();
  });

  it('replaces {year} in copyright', () => {
    renderFooter();
    const year = new Date().getFullYear();
    expect(screen.getByText(`© ${year} AnimeGo`)).toBeInTheDocument();
  });

  it('renders external social links with target=_blank and rel=noreferrer', () => {
    renderFooter();
    const github = screen.getByText('github').closest('a');
    expect(github).toHaveAttribute('href', 'https://github.com/lawrenceli0228/animego');
    expect(github).toHaveAttribute('target', '_blank');
    expect(github).toHaveAttribute('rel', 'noreferrer');
  });

  it('renders internal router links using <Link>', () => {
    renderFooter();
    const seasonal = screen.getByText('seasonal').closest('a');
    expect(seasonal).toHaveAttribute('href', '/season');
    const search = screen.getByText('search').closest('a');
    expect(search).toHaveAttribute('href', '/search');
  });

  it('data credits link to AniList and Bangumi', () => {
    renderFooter();
    expect(screen.getByText('AniList')).toHaveAttribute('href', 'https://anilist.co');
    expect(screen.getByText('Bangumi')).toHaveAttribute('href', 'https://bgm.tv');
  });

  it('applies hover color change on mouseenter/mouseleave', () => {
    renderFooter();
    const link = screen.getByText('donate').closest('a');
    fireEvent.mouseEnter(link);
    expect(link.style.color).toBe('rgb(255, 255, 255)');
    fireEvent.mouseLeave(link);
    // Reset color — style props return percentages/rgba in jsdom
    expect(link.style.color).not.toBe('rgb(255, 255, 255)');
  });
});

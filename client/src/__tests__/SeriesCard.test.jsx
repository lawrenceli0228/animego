import { render, screen, fireEvent } from '@testing-library/react';
import SeriesCard from '../components/library/SeriesCard';

/** @param {Partial<import('../lib/library/types').Series>} overrides */
function makeSeries(overrides = {}) {
  return {
    id: 's1',
    titleZh: '测试系列',
    titleEn: 'Test Series',
    type: 'tv',
    confidence: 0.9,
    createdAt: 1000,
    updatedAt: 1000,
    totalEpisodes: 12,
    ...overrides,
  };
}

describe('SeriesCard', () => {
  it('renders the series title', () => {
    render(<SeriesCard series={makeSeries()} onClick={vi.fn()} />);
    expect(screen.getByText('Test Series')).toBeInTheDocument();
  });

  it('renders LOCAL badge', () => {
    render(<SeriesCard series={makeSeries()} onClick={vi.fn()} />);
    expect(screen.getByTestId('local-badge')).toBeInTheDocument();
  });

  it('calls onClick when card is clicked', () => {
    const onClick = vi.fn();
    render(<SeriesCard series={makeSeries()} onClick={onClick} />);
    const card = screen.getByRole('button');
    fireEvent.click(card);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders episode count when totalEpisodes is set', () => {
    render(<SeriesCard series={makeSeries({ totalEpisodes: 24 })} onClick={vi.fn()} />);
    expect(screen.getByText('24')).toBeInTheDocument();
  });

  it('renders poster image when posterUrl is provided', () => {
    render(
      <SeriesCard
        series={makeSeries({ posterUrl: 'https://example.com/poster.jpg' })}
        onClick={vi.fn()}
      />
    );
    const img = screen.getByRole('img');
    expect(img).toHaveAttribute('src', 'https://example.com/poster.jpg');
  });

  it('renders monogram fallback when no posterUrl', () => {
    render(<SeriesCard series={makeSeries({ posterUrl: undefined })} onClick={vi.fn()} />);
    expect(screen.getByTestId('monogram')).toBeInTheDocument();
  });

  it('renders progress bar when progressPct is provided', () => {
    render(
      <SeriesCard series={makeSeries()} onClick={vi.fn()} progressPct={0.5} />
    );
    expect(screen.getByTestId('progress-bar')).toBeInTheDocument();
  });
});

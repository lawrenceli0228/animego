import { render, screen, fireEvent } from '@testing-library/react';
import SeriesGrid from '../components/library/SeriesGrid';

function makeSeries(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    titleEn: `Series ${i}`,
    type: 'tv',
    confidence: 0.9,
    createdAt: 1000,
    updatedAt: 1000,
  }));
}

describe('SeriesGrid', () => {
  it('renders N cards for N series', () => {
    render(<SeriesGrid series={makeSeries(4)} onPickSeries={vi.fn()} />);
    expect(screen.getAllByRole('button')).toHaveLength(4);
  });

  it('renders nothing when series array is empty', () => {
    const { container } = render(<SeriesGrid series={[]} onPickSeries={vi.fn()} />);
    expect(container.querySelector('[data-testid="series-grid"]')).toBeEmptyDOMElement();
  });

  it('calls onPickSeries with the series id when a card is clicked', () => {
    const onPickSeries = vi.fn();
    render(<SeriesGrid series={makeSeries(2)} onPickSeries={onPickSeries} />);
    fireEvent.click(screen.getAllByRole('button')[0]);
    expect(onPickSeries).toHaveBeenCalledWith('s0');
  });
});

import { render, screen, fireEvent } from '@testing-library/react';
import RecentlyPlayedRow from '../components/library/RecentlyPlayedRow';

function makeSeries(id = 's1', title = 'Test Series') {
  return { id, titleEn: title, type: 'tv', confidence: 0.9, createdAt: 1000, updatedAt: 1000 };
}

describe('RecentlyPlayedRow', () => {
  it('renders nothing when entries array is empty', () => {
    const { container } = render(<RecentlyPlayedRow entries={[]} onPlay={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders 2 cards when 2 entries provided', () => {
    const entries = [
      { series: makeSeries('s1', 'Alpha'), episodeNumber: 1, lastTimeSec: 300 },
      { series: makeSeries('s2', 'Beta'), episodeNumber: 2, lastTimeSec: 600 },
    ];
    render(<RecentlyPlayedRow entries={entries} onPlay={vi.fn()} />);
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('calls onPlay with seriesId and episodeNumber when a card is clicked', () => {
    const onPlay = vi.fn();
    const entries = [
      { series: makeSeries('s1', 'Alpha'), episodeNumber: 3, lastTimeSec: 120 },
    ];
    render(<RecentlyPlayedRow entries={entries} onPlay={onPlay} />);
    fireEvent.click(screen.getByText('Alpha'));
    expect(onPlay).toHaveBeenCalledWith('s1', 3);
  });
});

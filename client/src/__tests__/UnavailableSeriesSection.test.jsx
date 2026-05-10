import { render, screen, fireEvent } from '@testing-library/react';
import UnavailableSeriesSection from '../components/library/UnavailableSeriesSection';

const series = [
  { id: 's1', titleZh: '剧 A', posterUrl: null },
  { id: 's2', titleZh: '剧 B', posterUrl: null },
];
const availability = new Map([['s1', 'offline'], ['s2', 'partial']]);

describe('UnavailableSeriesSection', () => {
  it('renders the section header with reauthorize CTA when onReauthorize is provided', () => {
    render(
      <UnavailableSeriesSection
        series={series}
        availabilityBySeries={availability}
        onRefresh={vi.fn()}
        onReauthorize={vi.fn()}
        onPickSeries={vi.fn()}
        defaultOpen
      />
    );
    expect(screen.getByTestId('unavailable-reauthorize')).toHaveTextContent('重新授权');
    expect(screen.getByTestId('unavailable-refresh')).toHaveTextContent('刷新可用性');
  });

  it('omits the reauthorize CTA when onReauthorize is not provided', () => {
    render(
      <UnavailableSeriesSection
        series={series}
        availabilityBySeries={availability}
        onRefresh={vi.fn()}
        onPickSeries={vi.fn()}
        defaultOpen
      />
    );
    expect(screen.queryByTestId('unavailable-reauthorize')).toBeNull();
    expect(screen.getByTestId('unavailable-refresh')).toBeInTheDocument();
  });

  it('invokes onReauthorize on click without toggling the section open state', () => {
    const onReauthorize = vi.fn();
    render(
      <UnavailableSeriesSection
        series={series}
        availabilityBySeries={availability}
        onRefresh={vi.fn()}
        onReauthorize={onReauthorize}
        onPickSeries={vi.fn()}
        defaultOpen
      />
    );
    const list = screen.getByTestId('unavailable-list');
    expect(list).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('unavailable-reauthorize'));
    expect(onReauthorize).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('unavailable-list')).toBeInTheDocument();
  });

  it('shows a busy label and is disabled while reauthorizing=true', () => {
    const onReauthorize = vi.fn();
    render(
      <UnavailableSeriesSection
        series={series}
        availabilityBySeries={availability}
        onRefresh={vi.fn()}
        onReauthorize={onReauthorize}
        onPickSeries={vi.fn()}
        reauthorizing
        defaultOpen
      />
    );
    const btn = screen.getByTestId('unavailable-reauthorize');
    expect(btn).toHaveTextContent('授权中…');
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onReauthorize).not.toHaveBeenCalled();
  });
});

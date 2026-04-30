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

// ── P4-F-2: kebab menu for userOverride actions ──────────────────────────────

describe('SeriesCard kebab menu (P4-F-2)', () => {
  it('does not render kebab when no onOverrideAction is provided', () => {
    render(<SeriesCard series={makeSeries()} onClick={vi.fn()} />);
    expect(screen.queryByTestId('series-kebab')).not.toBeInTheDocument();
  });

  it('renders kebab when onOverrideAction is provided', () => {
    render(
      <SeriesCard
        series={makeSeries()}
        onClick={vi.fn()}
        onOverrideAction={vi.fn()}
      />,
    );
    expect(screen.getByTestId('series-kebab')).toBeInTheDocument();
  });

  it('clicking kebab does NOT trigger card onClick', () => {
    const onClick = vi.fn();
    render(
      <SeriesCard
        series={makeSeries()}
        onClick={onClick}
        onOverrideAction={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('series-kebab'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('clicking kebab opens the menu with all four base actions', () => {
    render(
      <SeriesCard
        series={makeSeries()}
        onClick={vi.fn()}
        onOverrideAction={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('series-kebab'));
    expect(screen.getByTestId('series-menu')).toBeInTheDocument();
    expect(screen.getByTestId('menu-lock')).toBeInTheDocument();
    expect(screen.getByTestId('menu-merge')).toBeInTheDocument();
    expect(screen.getByTestId('menu-split')).toBeInTheDocument();
  });

  it('shows "解锁" instead of "锁定" when override.locked is true', () => {
    render(
      <SeriesCard
        series={makeSeries()}
        onClick={vi.fn()}
        onOverrideAction={vi.fn()}
        override={{ seriesId: 's1', locked: true, updatedAt: 1 }}
      />,
    );
    fireEvent.click(screen.getByTestId('series-kebab'));
    expect(screen.getByTestId('menu-unlock')).toBeInTheDocument();
    expect(screen.queryByTestId('menu-lock')).not.toBeInTheDocument();
  });

  it('shows "清除覆盖" only when an override row exists', () => {
    const { unmount } = render(
      <SeriesCard
        series={makeSeries()}
        onClick={vi.fn()}
        onOverrideAction={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('series-kebab'));
    expect(screen.queryByTestId('menu-clear')).not.toBeInTheDocument();
    unmount();

    render(
      <SeriesCard
        series={makeSeries()}
        onClick={vi.fn()}
        onOverrideAction={vi.fn()}
        override={{ seriesId: 's1', locked: false, updatedAt: 1 }}
      />,
    );
    fireEvent.click(screen.getByTestId('series-kebab'));
    expect(screen.getByTestId('menu-clear')).toBeInTheDocument();
  });

  it('clicking a menu item fires onOverrideAction with the right action', () => {
    const onOverrideAction = vi.fn();
    render(
      <SeriesCard
        series={makeSeries()}
        onClick={vi.fn()}
        onOverrideAction={onOverrideAction}
      />,
    );
    fireEvent.click(screen.getByTestId('series-kebab'));
    fireEvent.click(screen.getByTestId('menu-merge'));
    expect(onOverrideAction).toHaveBeenCalledWith('merge');
  });

  it('renders LOCKED badge when override.locked is true', () => {
    render(
      <SeriesCard
        series={makeSeries()}
        onClick={vi.fn()}
        override={{ seriesId: 's1', locked: true, updatedAt: 1 }}
      />,
    );
    expect(screen.getByTestId('locked-badge')).toBeInTheDocument();
  });

  it('does not render LOCKED badge when override is absent or unlocked', () => {
    const { rerender } = render(
      <SeriesCard series={makeSeries()} onClick={vi.fn()} />,
    );
    expect(screen.queryByTestId('locked-badge')).not.toBeInTheDocument();

    rerender(
      <SeriesCard
        series={makeSeries()}
        onClick={vi.fn()}
        override={{ seriesId: 's1', locked: false, updatedAt: 1 }}
      />,
    );
    expect(screen.queryByTestId('locked-badge')).not.toBeInTheDocument();
  });

  it('clicking outside closes the menu', () => {
    render(
      <div>
        <SeriesCard
          series={makeSeries()}
          onClick={vi.fn()}
          onOverrideAction={vi.fn()}
        />
        <span data-testid="outside">outside</span>
      </div>,
    );
    fireEvent.click(screen.getByTestId('series-kebab'));
    expect(screen.getByTestId('series-menu')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(screen.queryByTestId('series-menu')).not.toBeInTheDocument();
  });
});

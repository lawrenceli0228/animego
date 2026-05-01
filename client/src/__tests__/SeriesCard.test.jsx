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

// ── §5.4 visual deltas: ⬡ LOCAL badge teal · iOS Blue progress · duration ───

describe('SeriesCard §5.4 visual markers', () => {
  it('LOCAL badge contains the ⬡ hexagon glyph', () => {
    render(<SeriesCard series={makeSeries()} onClick={vi.fn()} />);
    const badge = screen.getByTestId('local-badge');
    expect(badge.textContent).toMatch(/⬡/);
    expect(badge.textContent).toMatch(/LOCAL/);
  });

  it('LOCAL badge uses teal #5ac8fa color', () => {
    render(<SeriesCard series={makeSeries()} onClick={vi.fn()} />);
    const badge = screen.getByTestId('local-badge');
    expect(badge.style.color).toBe('rgb(90, 200, 250)');
  });

  it('progress bar fill uses iOS Blue #0a84ff', () => {
    const { container } = render(
      <SeriesCard series={makeSeries()} onClick={vi.fn()} progressPct={0.4} />,
    );
    const fill = container.querySelector('[data-testid="progress-bar"] > div');
    expect(fill).not.toBeNull();
    expect(/** @type {HTMLElement} */(fill).style.background).toContain('rgb(10, 132, 255)');
  });

  it('progress fill width tracks progressPct (0..1)', () => {
    const { container } = render(
      <SeriesCard series={makeSeries()} onClick={vi.fn()} progressPct={0.25} />,
    );
    const fill = /** @type {HTMLElement} */ (
      container.querySelector('[data-testid="progress-bar"] > div')
    );
    expect(fill.style.width).toBe('25%');
  });

  it('clamps progressPct above 1 to 100%', () => {
    const { container } = render(
      <SeriesCard series={makeSeries()} onClick={vi.fn()} progressPct={2} />,
    );
    const fill = /** @type {HTMLElement} */ (
      container.querySelector('[data-testid="progress-bar"] > div')
    );
    expect(fill.style.width).toBe('100%');
  });

  it('renders duration label when durationLabel prop is provided', () => {
    render(
      <SeriesCard
        series={makeSeries()}
        onClick={vi.fn()}
        durationLabel="11h 23m · 1080p"
      />,
    );
    expect(screen.getByTestId('duration-label')).toHaveTextContent('11h 23m · 1080p');
  });

  it('omits duration node when durationLabel is absent', () => {
    render(<SeriesCard series={makeSeries()} onClick={vi.fn()} />);
    expect(screen.queryByTestId('duration-label')).not.toBeInTheDocument();
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
    expect(screen.getByTestId('menu-rematch')).toBeInTheDocument();
  });

  it('clicking 重新匹配 fires onOverrideAction("rematch")', () => {
    const onOverrideAction = vi.fn();
    render(
      <SeriesCard
        series={makeSeries()}
        onClick={vi.fn()}
        onOverrideAction={onOverrideAction}
      />,
    );
    fireEvent.click(screen.getByTestId('series-kebab'));
    fireEvent.click(screen.getByTestId('menu-rematch'));
    expect(onOverrideAction).toHaveBeenCalledWith('rematch');
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

// ── §5.6 selection mode: toolbar + long-press + Shift-click ──────────────────

describe('SeriesCard §5.6 selection mode', () => {
  it('does not render select mark when selectionMode is false', () => {
    render(<SeriesCard series={makeSeries()} onClick={vi.fn()} selected />);
    expect(screen.queryByTestId('series-select-mark')).not.toBeInTheDocument();
  });

  it('renders empty ring mark when selectionMode + not selected', () => {
    render(<SeriesCard series={makeSeries()} onClick={vi.fn()} selectionMode />);
    const mark = screen.getByTestId('series-select-mark');
    expect(mark).toHaveAttribute('data-selected', 'false');
  });

  it('renders filled check mark when selectionMode + selected', () => {
    render(
      <SeriesCard series={makeSeries()} onClick={vi.fn()} selectionMode selected />,
    );
    const mark = screen.getByTestId('series-select-mark');
    expect(mark).toHaveAttribute('data-selected', 'true');
    expect(mark.textContent).toMatch(/✓/);
  });

  it('hides kebab when selectionMode is true', () => {
    render(
      <SeriesCard
        series={makeSeries()}
        onClick={vi.fn()}
        onOverrideAction={vi.fn()}
        selectionMode
      />,
    );
    expect(screen.queryByTestId('series-kebab')).not.toBeInTheDocument();
  });

  it('card click in selectionMode fires onToggleSelect, not onClick', () => {
    const onClick = vi.fn();
    const onToggleSelect = vi.fn();
    render(
      <SeriesCard
        series={makeSeries()}
        onClick={onClick}
        selectionMode
        onToggleSelect={onToggleSelect}
      />,
    );
    fireEvent.click(screen.getByTestId('series-card-root').querySelector('button'));
    expect(onToggleSelect).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('aria-pressed reflects selected state in selectionMode', () => {
    const { rerender } = render(
      <SeriesCard series={makeSeries()} onClick={vi.fn()} selectionMode />,
    );
    let btn = screen.getByTestId('series-card-root').querySelector('button');
    expect(btn).toHaveAttribute('aria-pressed', 'false');

    rerender(
      <SeriesCard series={makeSeries()} onClick={vi.fn()} selectionMode selected />,
    );
    btn = screen.getByTestId('series-card-root').querySelector('button');
    expect(btn).toHaveAttribute('aria-pressed', 'true');
  });

  it('long-press fires onLongPress after 500ms', () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    render(
      <SeriesCard
        series={makeSeries()}
        onClick={vi.fn()}
        onLongPress={onLongPress}
      />,
    );
    const btn = screen.getByTestId('series-card-root').querySelector('button');
    fireEvent.pointerDown(btn, { clientX: 10, clientY: 10 });
    expect(onLongPress).not.toHaveBeenCalled();
    vi.advanceTimersByTime(499);
    expect(onLongPress).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('long-press is cancelled if pointer moves > tolerance', () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    render(
      <SeriesCard
        series={makeSeries()}
        onClick={vi.fn()}
        onLongPress={onLongPress}
      />,
    );
    const btn = screen.getByTestId('series-card-root').querySelector('button');
    fireEvent.pointerDown(btn, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(btn, { clientX: 40, clientY: 40 });
    vi.advanceTimersByTime(600);
    expect(onLongPress).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('long-press is cancelled on pointerup before threshold', () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    render(
      <SeriesCard
        series={makeSeries()}
        onClick={vi.fn()}
        onLongPress={onLongPress}
      />,
    );
    const btn = screen.getByTestId('series-card-root').querySelector('button');
    fireEvent.pointerDown(btn, { clientX: 10, clientY: 10 });
    vi.advanceTimersByTime(200);
    fireEvent.pointerUp(btn);
    vi.advanceTimersByTime(600);
    expect(onLongPress).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('click that follows a fired long-press is suppressed', () => {
    vi.useFakeTimers();
    const onClick = vi.fn();
    const onLongPress = vi.fn();
    render(
      <SeriesCard
        series={makeSeries()}
        onClick={onClick}
        onLongPress={onLongPress}
      />,
    );
    const btn = screen.getByTestId('series-card-root').querySelector('button');
    fireEvent.pointerDown(btn, { clientX: 10, clientY: 10 });
    vi.advanceTimersByTime(600);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(btn);
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('passes the click event to onClick so callers can read shiftKey', () => {
    const onClick = vi.fn();
    render(<SeriesCard series={makeSeries()} onClick={onClick} />);
    const btn = screen.getByRole('button');
    fireEvent.click(btn, { shiftKey: true });
    expect(onClick).toHaveBeenCalledTimes(1);
    const arg = onClick.mock.calls[0][0];
    expect(arg).toBeDefined();
    expect(arg.shiftKey).toBe(true);
  });
});

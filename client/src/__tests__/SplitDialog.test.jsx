// @ts-check
import { render, screen, fireEvent } from '@testing-library/react';
import SplitDialog from '../components/library/SplitDialog';

/** @param {Partial<import('../lib/library/types').Series>} overrides */
function makeSeries(overrides = {}) {
  return {
    id: 's-default',
    titleZh: '默认',
    titleEn: 'Default',
    type: 'tv',
    confidence: 0.9,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

/** @param {Partial<import('../lib/library/types').Season>} overrides */
function makeSeason(overrides = {}) {
  return {
    id: 'sn-default',
    seriesId: 'src-1',
    number: 1,
    animeId: 100,
    updatedAt: 1000,
    _titleHint: 'Season 1',
    ...overrides,
  };
}

const SOURCE = makeSeries({ id: 'src-1', titleEn: 'Re:Zero' });
const SEASONS = [
  makeSeason({ id: 'sn-1', number: 1, animeId: 101, _titleHint: 'Re:Zero S1' }),
  makeSeason({ id: 'sn-2', number: 2, animeId: 102, _titleHint: 'Re:Zero S2' }),
  makeSeason({ id: 'sn-3', number: 3, animeId: 103, _titleHint: 'Re:Zero S3' }),
];

describe('SplitDialog', () => {
  it('renders nothing when open=false', () => {
    const { container } = render(
      <SplitDialog
        open={false}
        sourceSeries={SOURCE}
        seasons={SEASONS}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders backdrop + dialog when open=true', () => {
    render(
      <SplitDialog
        open
        sourceSeries={SOURCE}
        seasons={SEASONS}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByTestId('split-dialog-backdrop')).toBeInTheDocument();
    expect(screen.getByTestId('split-dialog')).toBeInTheDocument();
  });

  it('shows the source series title', () => {
    render(
      <SplitDialog
        open
        sourceSeries={SOURCE}
        seasons={SEASONS}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByTestId('split-source-title').textContent).toContain('Re:Zero');
  });

  it('renders one row per season', () => {
    render(
      <SplitDialog
        open
        sourceSeries={SOURCE}
        seasons={SEASONS}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByTestId('split-season-sn-1')).toBeInTheDocument();
    expect(screen.getByTestId('split-season-sn-2')).toBeInTheDocument();
    expect(screen.getByTestId('split-season-sn-3')).toBeInTheDocument();
  });

  it('confirm button is disabled when nothing is selected', () => {
    render(
      <SplitDialog
        open
        sourceSeries={SOURCE}
        seasons={SEASONS}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    const btn = /** @type {HTMLButtonElement} */ (screen.getByTestId('split-confirm'));
    expect(btn.disabled).toBe(true);
  });

  it('confirm button is disabled when name is empty', () => {
    render(
      <SplitDialog
        open
        sourceSeries={SOURCE}
        seasons={SEASONS}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('split-season-sn-2'));
    // Name field is empty by default → confirm should still be disabled.
    const btn = /** @type {HTMLButtonElement} */ (screen.getByTestId('split-confirm'));
    expect(btn.disabled).toBe(true);
  });

  it('confirm fires with selected seasons and entered name', () => {
    const onConfirm = vi.fn();
    render(
      <SplitDialog
        open
        sourceSeries={SOURCE}
        seasons={SEASONS}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByTestId('split-season-sn-2'));
    fireEvent.click(screen.getByTestId('split-season-sn-3'));
    fireEvent.change(screen.getByTestId('split-name'), {
      target: { value: 'Re:Zero S2-3' },
    });
    fireEvent.click(screen.getByTestId('split-confirm'));
    expect(onConfirm).toHaveBeenCalledWith({
      seasonIds: ['sn-2', 'sn-3'],
      name: 'Re:Zero S2-3',
    });
  });

  it('clicking a selected season toggles it off', () => {
    const onConfirm = vi.fn();
    render(
      <SplitDialog
        open
        sourceSeries={SOURCE}
        seasons={SEASONS}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByTestId('split-season-sn-1'));
    fireEvent.click(screen.getByTestId('split-season-sn-2'));
    fireEvent.click(screen.getByTestId('split-season-sn-1')); // toggle off
    fireEvent.change(screen.getByTestId('split-name'), {
      target: { value: 'X' },
    });
    fireEvent.click(screen.getByTestId('split-confirm'));
    expect(onConfirm).toHaveBeenCalledWith({ seasonIds: ['sn-2'], name: 'X' });
  });

  it('selecting all seasons disables confirm (cannot extract everything)', () => {
    render(
      <SplitDialog
        open
        sourceSeries={SOURCE}
        seasons={SEASONS}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('split-season-sn-1'));
    fireEvent.click(screen.getByTestId('split-season-sn-2'));
    fireEvent.click(screen.getByTestId('split-season-sn-3'));
    fireEvent.change(screen.getByTestId('split-name'), {
      target: { value: 'X' },
    });
    const btn = /** @type {HTMLButtonElement} */ (screen.getByTestId('split-confirm'));
    expect(btn.disabled).toBe(true);
  });

  it('clicking the backdrop calls onClose', () => {
    const onClose = vi.fn();
    render(
      <SplitDialog
        open
        sourceSeries={SOURCE}
        seasons={SEASONS}
        onClose={onClose}
        onConfirm={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('split-dialog-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking the dialog body does NOT call onClose', () => {
    const onClose = vi.fn();
    render(
      <SplitDialog
        open
        sourceSeries={SOURCE}
        seasons={SEASONS}
        onClose={onClose}
        onConfirm={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('split-dialog'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Escape calls onClose', () => {
    const onClose = vi.fn();
    render(
      <SplitDialog
        open
        sourceSeries={SOURCE}
        seasons={SEASONS}
        onClose={onClose}
        onConfirm={vi.fn()}
      />,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows empty-state when source has fewer than 2 seasons (nothing to split)', () => {
    render(
      <SplitDialog
        open
        sourceSeries={SOURCE}
        seasons={[SEASONS[0]]}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByTestId('split-empty')).toBeInTheDocument();
  });

  it('Cancel button calls onClose', () => {
    const onClose = vi.fn();
    render(
      <SplitDialog
        open
        sourceSeries={SOURCE}
        seasons={SEASONS}
        onClose={onClose}
        onConfirm={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('split-cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

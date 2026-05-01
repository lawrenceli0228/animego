// @ts-check
import { render, screen, fireEvent } from '@testing-library/react';
import MergeDialog from '../components/library/MergeDialog';

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

const SOURCE = makeSeries({ id: 'src-1', titleEn: 'Source Show' });
const TARGETS = [
  makeSeries({ id: 'tgt-a', titleEn: 'Alpha' }),
  makeSeries({ id: 'tgt-b', titleEn: 'Beta' }),
  makeSeries({ id: 'tgt-c', titleEn: 'Gamma' }),
];

describe('MergeDialog', () => {
  it('renders nothing when open=false', () => {
    const { container } = render(
      <MergeDialog
        open={false}
        sourceSeries={SOURCE}
        allSeries={[SOURCE, ...TARGETS]}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders backdrop + dialog when open=true', () => {
    render(
      <MergeDialog
        open
        sourceSeries={SOURCE}
        allSeries={[SOURCE, ...TARGETS]}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByTestId('merge-dialog-backdrop')).toBeInTheDocument();
    expect(screen.getByTestId('merge-dialog')).toBeInTheDocument();
  });

  it('shows the source series title in the header', () => {
    render(
      <MergeDialog
        open
        sourceSeries={SOURCE}
        allSeries={[SOURCE, ...TARGETS]}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByTestId('merge-source-title').textContent).toContain('Source Show');
  });

  it('lists all series except the source as target candidates', () => {
    render(
      <MergeDialog
        open
        sourceSeries={SOURCE}
        allSeries={[SOURCE, ...TARGETS]}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByTestId('merge-target-tgt-a')).toBeInTheDocument();
    expect(screen.getByTestId('merge-target-tgt-b')).toBeInTheDocument();
    expect(screen.getByTestId('merge-target-tgt-c')).toBeInTheDocument();
    expect(screen.queryByTestId('merge-target-src-1')).not.toBeInTheDocument();
  });

  it('clicking a target calls onConfirm with that series id', () => {
    const onConfirm = vi.fn();
    render(
      <MergeDialog
        open
        sourceSeries={SOURCE}
        allSeries={[SOURCE, ...TARGETS]}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByTestId('merge-target-tgt-b'));
    expect(onConfirm).toHaveBeenCalledWith('tgt-b');
  });

  it('clicking the backdrop calls onClose', () => {
    const onClose = vi.fn();
    render(
      <MergeDialog
        open
        sourceSeries={SOURCE}
        allSeries={[SOURCE, ...TARGETS]}
        onClose={onClose}
        onConfirm={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('merge-dialog-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking inside the dialog does NOT call onClose', () => {
    const onClose = vi.fn();
    render(
      <MergeDialog
        open
        sourceSeries={SOURCE}
        allSeries={[SOURCE, ...TARGETS]}
        onClose={onClose}
        onConfirm={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('merge-dialog'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Escape key calls onClose', () => {
    const onClose = vi.fn();
    render(
      <MergeDialog
        open
        sourceSeries={SOURCE}
        allSeries={[SOURCE, ...TARGETS]}
        onClose={onClose}
        onConfirm={vi.fn()}
      />,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows empty-state message when no other series exist', () => {
    render(
      <MergeDialog
        open
        sourceSeries={SOURCE}
        allSeries={[SOURCE]}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByTestId('merge-empty')).toBeInTheDocument();
  });

  it('Cancel button calls onClose', () => {
    const onClose = vi.fn();
    render(
      <MergeDialog
        open
        sourceSeries={SOURCE}
        allSeries={[SOURCE, ...TARGETS]}
        onClose={onClose}
        onConfirm={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('merge-cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('filters target list when search input is typed', () => {
    render(
      <MergeDialog
        open
        sourceSeries={SOURCE}
        allSeries={[SOURCE, ...TARGETS]}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId('merge-search'), { target: { value: 'beta' } });
    expect(screen.queryByTestId('merge-target-tgt-a')).not.toBeInTheDocument();
    expect(screen.getByTestId('merge-target-tgt-b')).toBeInTheDocument();
    expect(screen.queryByTestId('merge-target-tgt-c')).not.toBeInTheDocument();
  });
});

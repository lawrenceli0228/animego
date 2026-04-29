import { render, screen, fireEvent } from '@testing-library/react';
import MultiGroupPicker from '../components/library/MultiGroupPicker';

/** @param {Partial<import('../lib/library/types').Group>} overrides */
function makeGroup(overrides = {}) {
  return {
    id: 'g1',
    groupKey: 'Show/Season1',
    label: 'Season1',
    items: [{ fileId: 'f1' }, { fileId: 'f2' }],
    sortMode: 'episode',
    hasAmbiguity: false,
    ...overrides,
  };
}

describe('MultiGroupPicker', () => {
  it('renders 3 cards when 3 groups supplied', () => {
    const groups = [
      makeGroup({ id: 'g1', label: 'Season1', items: [{}] }),
      makeGroup({ id: 'g2', label: 'Season2', items: [{}, {}] }),
      makeGroup({ id: 'g3', label: 'Season3', items: [{}, {}, {}] }),
    ];
    render(<MultiGroupPicker groups={groups} onPick={vi.fn()} />);
    expect(screen.getByText('Season1')).toBeInTheDocument();
    expect(screen.getByText('Season2')).toBeInTheDocument();
    expect(screen.getByText('Season3')).toBeInTheDocument();
  });

  it('renders nothing when only 1 group supplied', () => {
    const { container } = render(
      <MultiGroupPicker groups={[makeGroup()]} onPick={vi.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when 0 groups supplied', () => {
    const { container } = render(
      <MultiGroupPicker groups={[]} onPick={vi.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('calls onPick with the correct group when a card is clicked', () => {
    const g1 = makeGroup({ id: 'g1', label: 'Alpha' });
    const g2 = makeGroup({ id: 'g2', label: 'Beta' });
    const onPick = vi.fn();
    render(<MultiGroupPicker groups={[g1, g2]} onPick={onPick} />);
    fireEvent.click(screen.getByText('Alpha'));
    expect(onPick).toHaveBeenCalledWith(g1);
  });

  it('shows ambiguity badge when hasAmbiguity is true', () => {
    const groups = [
      makeGroup({ id: 'g1', label: 'Ambig', hasAmbiguity: true }),
      makeGroup({ id: 'g2', label: 'Clean', hasAmbiguity: false }),
    ];
    render(<MultiGroupPicker groups={groups} onPick={vi.fn()} />);
    expect(screen.getByTestId('ambiguity-badge-g1')).toBeInTheDocument();
    expect(screen.queryByTestId('ambiguity-badge-g2')).not.toBeInTheDocument();
  });

  it('renders file counts for each group', () => {
    const groups = [
      makeGroup({ id: 'g1', label: 'One', items: [{}] }),
      makeGroup({ id: 'g2', label: 'Two', items: [{}, {}] }),
    ];
    render(<MultiGroupPicker groups={groups} onPick={vi.fn()} />);
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('calls onPickAll when "Pick all" button is clicked', () => {
    const groups = [
      makeGroup({ id: 'g1', label: 'A' }),
      makeGroup({ id: 'g2', label: 'B' }),
    ];
    const onPickAll = vi.fn();
    render(<MultiGroupPicker groups={groups} onPick={vi.fn()} onPickAll={onPickAll} />);
    fireEvent.click(screen.getByRole('button', { name: /pick all/i }));
    expect(onPickAll).toHaveBeenCalledTimes(1);
  });
});

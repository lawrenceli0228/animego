// @ts-check
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

import FilterChips from '../components/library/FilterChips.jsx';

describe('FilterChips', () => {
  it('renders the four §5.4 chips', () => {
    render(<FilterChips active={null} onChange={vi.fn()} />);
    expect(screen.getByTestId('filter-chip-recent')).toBeInTheDocument();
    expect(screen.getByTestId('filter-chip-new')).toBeInTheDocument();
    expect(screen.getByTestId('filter-chip-inProgress')).toBeInTheDocument();
    expect(screen.getByTestId('filter-chip-done')).toBeInTheDocument();
  });

  it('marks the active chip with aria-pressed=true', () => {
    render(<FilterChips active="recent" onChange={vi.fn()} />);
    expect(screen.getByTestId('filter-chip-recent')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('filter-chip-new')).toHaveAttribute('aria-pressed', 'false');
  });

  it('clicking an inactive chip fires onChange with that id', () => {
    const onChange = vi.fn();
    render(<FilterChips active={null} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('filter-chip-inProgress'));
    expect(onChange).toHaveBeenCalledWith('inProgress');
  });

  it('clicking the active chip clears the filter (fires null)', () => {
    const onChange = vi.fn();
    render(<FilterChips active="done" onChange={onChange} />);
    fireEvent.click(screen.getByTestId('filter-chip-done'));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('hides the 清除 button when no filter is active', () => {
    render(<FilterChips active={null} onChange={vi.fn()} />);
    expect(screen.queryByTestId('filter-chip-clear')).not.toBeInTheDocument();
  });

  it('shows 清除 button when a filter is active and clears on click', () => {
    const onChange = vi.fn();
    render(<FilterChips active="new" onChange={onChange} />);
    const clear = screen.getByTestId('filter-chip-clear');
    expect(clear).toBeInTheDocument();
    fireEvent.click(clear);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('toolbar role is set on the row for assistive tech', () => {
    render(<FilterChips active={null} onChange={vi.fn()} />);
    const row = screen.getByTestId('library-filters');
    expect(row).toHaveAttribute('role', 'toolbar');
    expect(row).toHaveAttribute('aria-label', '库筛选');
  });

  afterEach(() => cleanup());
});

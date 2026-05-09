// @ts-check
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import BulkActionToolbar from '../components/library/BulkActionToolbar.jsx';

function mount(extra = {}) {
  const onCancel = vi.fn();
  const onSelectAll = vi.fn();
  const onMerge = vi.fn();
  const utils = render(
    <BulkActionToolbar
      count={0}
      onCancel={onCancel}
      onSelectAll={onSelectAll}
      onMerge={onMerge}
      {...extra}
    />,
  );
  return { onCancel, onSelectAll, onMerge, ...utils };
}

describe('BulkActionToolbar', () => {
  afterEach(() => cleanup());

  it('renders the four controls and toolbar role', () => {
    mount({ count: 1 });
    const bar = screen.getByTestId('bulk-toolbar');
    expect(bar).toHaveAttribute('role', 'toolbar');
    expect(bar).toHaveAttribute('aria-label', '批量操作');
    expect(screen.getByTestId('bulk-toolbar-cancel')).toBeInTheDocument();
    expect(screen.getByTestId('bulk-toolbar-count')).toBeInTheDocument();
    expect(screen.getByTestId('bulk-toolbar-select-all')).toBeInTheDocument();
    expect(screen.getByTestId('bulk-toolbar-merge')).toBeInTheDocument();
  });

  it('count text shows the number', () => {
    mount({ count: 3 });
    expect(screen.getByTestId('bulk-toolbar-count')).toHaveTextContent('3');
    expect(screen.getByTestId('bulk-toolbar-count')).toHaveTextContent('项已选');
  });

  it('Cancel fires onCancel', () => {
    const { onCancel } = mount({ count: 2 });
    fireEvent.click(screen.getByTestId('bulk-toolbar-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('全选 fires onSelectAll', () => {
    const { onSelectAll } = mount({ count: 1 });
    fireEvent.click(screen.getByTestId('bulk-toolbar-select-all'));
    expect(onSelectAll).toHaveBeenCalledTimes(1);
  });

  it('合并按钮在少于 2 项时禁用,且不触发 onMerge', () => {
    const { onMerge } = mount({ count: 1 });
    const btn = screen.getByTestId('bulk-toolbar-merge');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(btn);
    expect(onMerge).not.toHaveBeenCalled();
  });

  it('合并按钮在 ≥2 项时启用并触发 onMerge', () => {
    const { onMerge } = mount({ count: 2 });
    const btn = screen.getByTestId('bulk-toolbar-merge');
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(onMerge).toHaveBeenCalledTimes(1);
  });

  it('minMerge=3 强制更高门槛', () => {
    const { onMerge } = mount({ count: 2, minMerge: 3 });
    const btn = screen.getByTestId('bulk-toolbar-merge');
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onMerge).not.toHaveBeenCalled();
  });
});

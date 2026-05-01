// @ts-check
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import SeriesActionsMenu from '../components/library/SeriesActionsMenu.jsx';

afterEach(() => cleanup());

function mount(over = {}) {
  const onMerge = vi.fn();
  const onSplit = vi.fn();
  const onRematch = vi.fn();
  const utils = render(
    <SeriesActionsMenu
      onMerge={onMerge}
      onSplit={onSplit}
      onRematch={onRematch}
      {...over}
    />,
  );
  return { onMerge, onSplit, onRematch, ...utils };
}

describe('SeriesActionsMenu', () => {
  it('renders the trigger button (closed by default)', () => {
    mount();
    expect(screen.getByTestId('actions-btn')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('actions-menu')).not.toBeInTheDocument();
  });

  it('clicking the trigger opens the menu with three items', () => {
    mount();
    fireEvent.click(screen.getByTestId('actions-btn'));
    expect(screen.getByTestId('actions-btn')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('actions-menu')).toBeInTheDocument();
    expect(screen.getByTestId('action-merge')).toHaveTextContent('合并到其他系列');
    expect(screen.getByTestId('action-split')).toHaveTextContent('拆分此系列');
    expect(screen.getByTestId('action-rematch')).toHaveTextContent('重新匹配');
  });

  it('clicking 合并 fires onMerge and closes the menu', () => {
    const { onMerge, onSplit, onRematch } = mount();
    fireEvent.click(screen.getByTestId('actions-btn'));
    fireEvent.click(screen.getByTestId('action-merge'));
    expect(onMerge).toHaveBeenCalledTimes(1);
    expect(onSplit).not.toHaveBeenCalled();
    expect(onRematch).not.toHaveBeenCalled();
    expect(screen.queryByTestId('actions-menu')).not.toBeInTheDocument();
  });

  it('clicking 拆分 fires onSplit', () => {
    const { onSplit } = mount();
    fireEvent.click(screen.getByTestId('actions-btn'));
    fireEvent.click(screen.getByTestId('action-split'));
    expect(onSplit).toHaveBeenCalledTimes(1);
  });

  it('clicking 重新匹配 fires onRematch', () => {
    const { onRematch } = mount();
    fireEvent.click(screen.getByTestId('actions-btn'));
    fireEvent.click(screen.getByTestId('action-rematch'));
    expect(onRematch).toHaveBeenCalledTimes(1);
  });

  it('mousedown outside the menu closes it (click-outside)', () => {
    render(
      <div>
        <SeriesActionsMenu onMerge={() => {}} onSplit={() => {}} onRematch={() => {}} />
        <div data-testid="outside">outside</div>
      </div>,
    );
    fireEvent.click(screen.getByTestId('actions-btn'));
    expect(screen.getByTestId('actions-menu')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(screen.queryByTestId('actions-menu')).not.toBeInTheDocument();
  });

  it('toggling — second click on trigger closes the menu', () => {
    mount();
    fireEvent.click(screen.getByTestId('actions-btn'));
    expect(screen.getByTestId('actions-menu')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('actions-btn'));
    expect(screen.queryByTestId('actions-menu')).not.toBeInTheDocument();
  });

  it('respects custom label prop', () => {
    mount({ label: '管理 ▾' });
    expect(screen.getByTestId('actions-btn')).toHaveTextContent('管理 ▾');
  });

  it('omits 操作日志 when onOpsLog is not provided', () => {
    mount();
    fireEvent.click(screen.getByTestId('actions-btn'));
    expect(screen.queryByTestId('action-opslog')).not.toBeInTheDocument();
  });

  it('renders 操作日志 when onOpsLog is provided and fires the callback', () => {
    const onOpsLog = vi.fn();
    mount({ onOpsLog });
    fireEvent.click(screen.getByTestId('actions-btn'));
    const item = screen.getByTestId('action-opslog');
    expect(item).toHaveTextContent('操作日志');
    fireEvent.click(item);
    expect(onOpsLog).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('actions-menu')).not.toBeInTheDocument();
  });
});

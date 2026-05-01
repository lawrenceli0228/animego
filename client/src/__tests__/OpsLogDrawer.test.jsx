// @ts-check
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import OpsLogDrawer, { formatTimeAgo } from '../components/library/OpsLogDrawer.jsx';

afterEach(() => cleanup());

function makeEntry(over = {}) {
  return {
    id: 'op_1',
    seriesId: 'series-1',
    ts: Date.now() - 60_000,
    kind: 'merge',
    payload: {},
    summary: { targetTitle: 'Attack on Titan', sourceTitle: '进击的巨人' },
    undoableUntil: Date.now() + 86_400_000,
    undone: false,
    ...over,
  };
}

describe('OpsLogDrawer — visibility', () => {
  it('renders nothing when open=false', () => {
    render(<OpsLogDrawer open={false} entries={[]} onClose={() => {}} />);
    expect(screen.queryByTestId('opslog-drawer')).not.toBeInTheDocument();
  });

  it('renders the drawer + scrim when open=true', () => {
    render(<OpsLogDrawer open entries={[]} onClose={() => {}} />);
    expect(screen.getByTestId('opslog-drawer')).toBeInTheDocument();
    expect(screen.getByTestId('opslog-scrim')).toBeInTheDocument();
  });
});

describe('OpsLogDrawer — empty state', () => {
  it('shows the empty hint when no entries', () => {
    render(<OpsLogDrawer open entries={[]} onClose={() => {}} />);
    expect(screen.getByTestId('opslog-empty')).toBeInTheDocument();
    expect(screen.getByTestId('opslog-empty').textContent).toMatch(/暂无近期操作/);
  });
});

describe('OpsLogDrawer — entry rendering', () => {
  it('renders one row per entry with kind data attribute', () => {
    const entries = [
      makeEntry({ id: 'op_a', kind: 'merge' }),
      makeEntry({ id: 'op_b', kind: 'split' }),
      makeEntry({ id: 'op_c', kind: 'rematch' }),
    ];
    render(<OpsLogDrawer open entries={entries} onClose={() => {}} />);
    expect(screen.getByTestId('opslog-row-op_a')).toHaveAttribute('data-kind', 'merge');
    expect(screen.getByTestId('opslog-row-op_b')).toHaveAttribute('data-kind', 'split');
    expect(screen.getByTestId('opslog-row-op_c')).toHaveAttribute('data-kind', 'rematch');
  });

  it('renders merge summary using sourceTitle → targetTitle', () => {
    const entries = [makeEntry({
      summary: { sourceTitle: '巨人A', targetTitle: '巨人B' },
    })];
    render(<OpsLogDrawer open entries={entries} onClose={() => {}} />);
    const row = screen.getByTestId('opslog-row-op_1');
    expect(row.textContent).toMatch(/巨人A/);
    expect(row.textContent).toMatch(/巨人B/);
  });

  it('renders split summary with new series name when present', () => {
    const entries = [makeEntry({
      kind: 'split',
      summary: { name: '剧场版' },
    })];
    render(<OpsLogDrawer open entries={entries} onClose={() => {}} />);
    expect(screen.getByTestId('opslog-row-op_1').textContent).toMatch(/剧场版/);
  });

  it('marks undone entries with the UNDONE badge', () => {
    const entries = [makeEntry({ undone: true })];
    render(<OpsLogDrawer open entries={entries} onClose={() => {}} />);
    expect(screen.getByTestId('opslog-row-op_1')).toHaveAttribute('data-undone', '1');
    expect(screen.getByTestId('opslog-undone-op_1')).toBeInTheDocument();
  });

  it('does not show the UNDONE badge for live entries', () => {
    const entries = [makeEntry({ undone: false })];
    render(<OpsLogDrawer open entries={entries} onClose={() => {}} />);
    expect(screen.queryByTestId('opslog-undone-op_1')).not.toBeInTheDocument();
  });

  it('falls back to bare kind text when summary fields are missing', () => {
    const entries = [makeEntry({ summary: {} })];
    render(<OpsLogDrawer open entries={entries} onClose={() => {}} />);
    expect(screen.getByTestId('opslog-row-op_1').textContent).toMatch(/合并/);
  });
});

describe('OpsLogDrawer — close behavior', () => {
  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn();
    render(<OpsLogDrawer open entries={[]} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('opslog-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when the scrim is clicked', () => {
    const onClose = vi.fn();
    render(<OpsLogDrawer open entries={[]} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('opslog-scrim'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn();
    render(<OpsLogDrawer open entries={[]} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('OpsLogDrawer — formatTimeAgo', () => {
  const now = 1_700_000_000_000;
  it('returns 刚刚 within 60s', () => {
    expect(formatTimeAgo(now - 30_000, now)).toBe('刚刚');
  });
  it('returns minutes within the hour', () => {
    expect(formatTimeAgo(now - 5 * 60_000, now)).toBe('5 分钟前');
  });
  it('returns hours within the day', () => {
    expect(formatTimeAgo(now - 3 * 3600_000, now)).toBe('3 小时前');
  });
  it('returns days within the month', () => {
    expect(formatTimeAgo(now - 5 * 86400_000, now)).toBe('5 天前');
  });
  it('falls back to absolute date past 30 days', () => {
    const result = formatTimeAgo(now - 60 * 86400_000, now);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// @ts-check
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import ImportDrawer, { aggregateEvents } from '../components/library/ImportDrawer.jsx';

/** @typedef {import('../lib/library/types').ImportEvent} ImportEvent */

function start(clusterKey, total = 1) {
  return /** @type {ImportEvent} */ ({ kind: 'clusterStart', clusterKey, total });
}
function done(clusterKey, verdict) {
  return /** @type {ImportEvent} */ ({ kind: 'clusterDone', clusterKey, verdict });
}
function failed(clusterKey, error) {
  return /** @type {ImportEvent} */ ({ kind: 'failed', clusterKey, error });
}

// ── aggregateEvents ───────────────────────────────────────────────────────────

describe('aggregateEvents', () => {
  it('returns empty rows for empty input', () => {
    const out = aggregateEvents([]);
    expect(out.rows).toEqual([]);
    expect(out.total).toBe(0);
    expect(out.finished).toBe(0);
  });

  it('preserves cluster start order', () => {
    const out = aggregateEvents([start('a'), start('b'), start('c')]);
    expect(out.rows.map((r) => r.clusterKey)).toEqual(['a', 'b', 'c']);
  });

  it('keeps unfinished clusters in running state', () => {
    const out = aggregateEvents([start('a', 3)]);
    expect(out.rows[0]).toMatchObject({ clusterKey: 'a', total: 3, state: 'running' });
    expect(out.finished).toBe(0);
  });

  it('marks matched verdicts', () => {
    const out = aggregateEvents([start('a'), done('a', 'matched')]);
    expect(out.rows[0].state).toBe('matched');
    expect(out.finished).toBe(1);
  });

  it('marks ambiguous verdicts', () => {
    const out = aggregateEvents([start('a'), done('a', 'ambiguous')]);
    expect(out.rows[0].state).toBe('ambiguous');
  });

  it('marks failed verdicts and records errors', () => {
    const out = aggregateEvents([start('a'), done('a', 'failed'), failed('a', 'boom')]);
    expect(out.rows[0]).toMatchObject({ state: 'failed', error: 'boom' });
  });

  it('counts only finished rows', () => {
    const out = aggregateEvents([
      start('a'), done('a', 'matched'),
      start('b'),
      start('c'), done('c', 'failed'),
    ]);
    expect(out.total).toBe(3);
    expect(out.finished).toBe(2);
  });
});

// ── component render ──────────────────────────────────────────────────────────

describe('ImportDrawer — render', () => {
  it('returns null when status is idle and no progress', () => {
    const { container } = render(
      <ImportDrawer status="idle" progress={[]} summary={null} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders drawer when status is running', () => {
    render(
      <ImportDrawer
        status="running"
        progress={[start('a', 2)]}
        summary={null}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTestId('import-drawer')).toBeInTheDocument();
    expect(screen.getByTestId('import-row-a')).toBeInTheDocument();
  });

  it('shows the IMPORT.QUEUE title kicker', () => {
    render(
      <ImportDrawer
        status="running"
        progress={[start('a')]}
        summary={null}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTestId('import-drawer-title').textContent).toMatch(/IMPORT\.QUEUE/);
  });

  it('renders matched glyph for matched cluster', () => {
    render(
      <ImportDrawer
        status="running"
        progress={[start('a'), done('a', 'matched')]}
        summary={null}
      />,
    );
    const row = screen.getByTestId('import-row-a');
    expect(row.getAttribute('data-state')).toBe('matched');
    expect(row.textContent).toMatch(/✓/);
  });

  it('renders ambiguous glyph for ambiguous cluster', () => {
    render(
      <ImportDrawer
        status="running"
        progress={[start('a'), done('a', 'ambiguous')]}
        summary={null}
      />,
    );
    const row = screen.getByTestId('import-row-a');
    expect(row.getAttribute('data-state')).toBe('ambiguous');
    expect(row.textContent).toMatch(/⚠/);
  });

  it('renders failed glyph for failed cluster', () => {
    render(
      <ImportDrawer
        status="running"
        progress={[start('a'), done('a', 'failed')]}
        summary={null}
      />,
    );
    const row = screen.getByTestId('import-row-a');
    expect(row.getAttribute('data-state')).toBe('failed');
    expect(row.textContent).toMatch(/✗/);
  });

  it('shows running glyph + pulsing for in-flight rows', () => {
    render(
      <ImportDrawer
        status="running"
        progress={[start('a')]}
        summary={null}
        onCancel={vi.fn()}
      />,
    );
    const row = screen.getByTestId('import-row-a');
    expect(row.getAttribute('data-state')).toBe('running');
    expect(row.textContent).toMatch(/⟳/);
  });

  it('shows preparing message before any cluster starts', () => {
    render(
      <ImportDrawer
        status="running"
        progress={[]}
        summary={null}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTestId('import-drawer-empty').textContent).toMatch(/准备中/);
  });
});

// ── counter ───────────────────────────────────────────────────────────────────

describe('ImportDrawer — counter', () => {
  it('shows finished/total while running', () => {
    render(
      <ImportDrawer
        status="running"
        progress={[
          start('a'), done('a', 'matched'),
          start('b'),
        ]}
        summary={null}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTestId('import-drawer-counter').textContent).toMatch(/完成 1 \/ 2/);
  });

  it('uses summary when status=done', () => {
    render(
      <ImportDrawer
        status="done"
        progress={[start('a'), done('a', 'matched')]}
        summary={{ clusters: 5, matched: 4, failed: 1, ambiguous: 0 }}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByTestId('import-drawer-counter').textContent).toMatch(/完成 5 \/ 5/);
  });
});

// ── controls ──────────────────────────────────────────────────────────────────

describe('ImportDrawer — controls', () => {
  it('shows cancel only when running', () => {
    render(
      <ImportDrawer
        status="running"
        progress={[start('a')]}
        summary={null}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTestId('import-drawer-cancel')).toBeInTheDocument();
    expect(screen.queryByTestId('import-drawer-dismiss')).not.toBeInTheDocument();
  });

  it('does not render cancel without an onCancel prop', () => {
    render(
      <ImportDrawer status="running" progress={[start('a')]} summary={null} />,
    );
    expect(screen.queryByTestId('import-drawer-cancel')).not.toBeInTheDocument();
  });

  it('invokes onCancel when cancel clicked', () => {
    const onCancel = vi.fn();
    render(
      <ImportDrawer
        status="running"
        progress={[start('a')]}
        summary={null}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByTestId('import-drawer-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows dismiss + close (×) when status=done', () => {
    const onDismiss = vi.fn();
    render(
      <ImportDrawer
        status="done"
        progress={[start('a'), done('a', 'matched')]}
        summary={{ clusters: 1, matched: 1, failed: 0, ambiguous: 0 }}
        onDismiss={onDismiss}
      />,
    );
    expect(screen.getByTestId('import-drawer-dismiss')).toBeInTheDocument();
    expect(screen.getByTestId('import-drawer-close')).toBeInTheDocument();
    expect(screen.queryByTestId('import-drawer-cancel')).not.toBeInTheDocument();
  });

  it('invokes onDismiss when dismiss clicked', () => {
    const onDismiss = vi.fn();
    render(
      <ImportDrawer
        status="done"
        progress={[start('a'), done('a', 'matched')]}
        summary={{ clusters: 1, matched: 1, failed: 0, ambiguous: 0 }}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByTestId('import-drawer-dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('shows error banner when error is present', () => {
    render(
      <ImportDrawer
        status="error"
        progress={[start('a'), done('a', 'failed')]}
        summary={null}
        error="磁盘已满"
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByTestId('import-drawer-error').textContent).toMatch(/磁盘已满/);
  });
});

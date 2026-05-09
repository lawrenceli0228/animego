// @ts-check
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import UnclassifiedSection from '../components/library/UnclassifiedSection.jsx';

function makeFileRef(over = {}) {
  return {
    id: 'fr-1',
    libraryId: 'lib-1',
    relPath: '正片/UNK01.mkv',
    size: 1024,
    mtime: 0,
    matchStatus: 'pending',
    ...over,
  };
}

describe('UnclassifiedSection — visibility', () => {
  it('renders nothing when entries is empty', () => {
    const { container } = render(<UnclassifiedSection entries={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the section + count when entries are present', () => {
    render(
      <UnclassifiedSection
        entries={[makeFileRef(), makeFileRef({ id: 'fr-2', relPath: 'b.mkv' })]}
      />,
    );
    expect(screen.getByTestId('unclassified-section')).toBeInTheDocument();
    expect(screen.getByTestId('unclassified-count').textContent).toMatch(/2 个文件/);
  });
});

describe('UnclassifiedSection — collapse', () => {
  it('starts collapsed by default (no list rendered)', () => {
    render(<UnclassifiedSection entries={[makeFileRef()]} />);
    expect(screen.queryByTestId('unclassified-list')).not.toBeInTheDocument();
  });

  it('expands when toggle is clicked', () => {
    render(<UnclassifiedSection entries={[makeFileRef()]} />);
    fireEvent.click(screen.getByTestId('unclassified-toggle'));
    expect(screen.getByTestId('unclassified-list')).toBeInTheDocument();
  });

  it('honors defaultOpen=true', () => {
    render(<UnclassifiedSection entries={[makeFileRef()]} defaultOpen />);
    expect(screen.getByTestId('unclassified-list')).toBeInTheDocument();
  });

  it('collapses again after a second click', () => {
    render(<UnclassifiedSection entries={[makeFileRef()]} defaultOpen />);
    fireEvent.click(screen.getByTestId('unclassified-toggle'));
    expect(screen.queryByTestId('unclassified-list')).not.toBeInTheDocument();
  });
});

describe('UnclassifiedSection — rows', () => {
  it('renders one row per entry with file name and parent dir', () => {
    render(
      <UnclassifiedSection
        entries={[
          makeFileRef({ id: 'fr-1', relPath: '正片/UNK01.mkv' }),
          makeFileRef({ id: 'fr-2', relPath: 'random.mp4' }),
        ]}
        defaultOpen
      />,
    );
    const a = screen.getByTestId('unclassified-row-fr-1');
    expect(a.textContent).toMatch(/UNK01\.mkv/);
    expect(a.textContent).toMatch(/正片/);
    const b = screen.getByTestId('unclassified-row-fr-2');
    expect(b.textContent).toMatch(/random\.mp4/);
    expect(b.textContent).toMatch(/\(根\)/);
  });

  it('sorts rows by relPath', () => {
    render(
      <UnclassifiedSection
        entries={[
          makeFileRef({ id: 'z', relPath: 'zeta.mkv' }),
          makeFileRef({ id: 'a', relPath: 'alpha.mkv' }),
        ]}
        defaultOpen
      />,
    );
    const rows = screen.getAllByTestId(/^unclassified-row-/);
    expect(rows[0].getAttribute('data-testid')).toBe('unclassified-row-a');
    expect(rows[1].getAttribute('data-testid')).toBe('unclassified-row-z');
  });

  it('shows status label for each row', () => {
    render(
      <UnclassifiedSection
        entries={[
          makeFileRef({ id: 'a', matchStatus: 'pending', relPath: 'a.mkv' }),
          makeFileRef({ id: 'b', matchStatus: 'failed', relPath: 'b.mkv' }),
          makeFileRef({ id: 'c', matchStatus: 'ambiguous', relPath: 'c.mkv' }),
        ]}
        defaultOpen
      />,
    );
    expect(screen.getByTestId('unclassified-row-a').textContent).toMatch(/PENDING/);
    expect(screen.getByTestId('unclassified-row-b').textContent).toMatch(/UNKNOWN/);
    expect(screen.getByTestId('unclassified-row-c').textContent).toMatch(/LOW CONF/);
  });
});

describe('UnclassifiedSection — actions', () => {
  it('invokes onSearch with the fileRef', () => {
    const onSearch = vi.fn();
    const fr = makeFileRef();
    render(
      <UnclassifiedSection entries={[fr]} defaultOpen onSearch={onSearch} />,
    );
    fireEvent.click(screen.getByTestId(`unclassified-search-${fr.id}`));
    expect(onSearch).toHaveBeenCalledWith(fr);
  });

  it('invokes onCreateLocal with the fileRef', () => {
    const onCreateLocal = vi.fn();
    const fr = makeFileRef();
    render(
      <UnclassifiedSection entries={[fr]} defaultOpen onCreateLocal={onCreateLocal} />,
    );
    fireEvent.click(screen.getByTestId(`unclassified-create-${fr.id}`));
    expect(onCreateLocal).toHaveBeenCalledWith(fr);
  });

  it('invokes onIgnore with the fileRef', () => {
    const onIgnore = vi.fn();
    const fr = makeFileRef();
    render(
      <UnclassifiedSection entries={[fr]} defaultOpen onIgnore={onIgnore} />,
    );
    fireEvent.click(screen.getByTestId(`unclassified-ignore-${fr.id}`));
    expect(onIgnore).toHaveBeenCalledWith(fr);
  });

  it('disables action buttons when callback is not provided', () => {
    const fr = makeFileRef();
    render(<UnclassifiedSection entries={[fr]} defaultOpen />);
    expect(screen.getByTestId(`unclassified-search-${fr.id}`)).toBeDisabled();
    expect(screen.getByTestId(`unclassified-create-${fr.id}`)).toBeDisabled();
    expect(screen.getByTestId(`unclassified-ignore-${fr.id}`)).toBeDisabled();
  });
});

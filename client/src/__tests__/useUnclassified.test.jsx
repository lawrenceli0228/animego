// @ts-check
import 'fake-indexeddb/auto';
import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { getDb } from '../lib/library/db/db.js';
import useUnclassified from '../hooks/useUnclassified.js';

function Probe({ db }) {
  const { entries, loading } = useUnclassified({ db });
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="count">{entries.length}</span>
      <ul>
        {entries.map((e) => (
          <li key={e.id} data-testid="entry">
            {e.id}|{e.matchStatus}|{e.relPath}
          </li>
        ))}
      </ul>
    </div>
  );
}

function makeFileRef(id, status, relPath, libraryId = 'lib-1') {
  return {
    id,
    libraryId,
    relPath,
    size: 1024,
    mtime: 0,
    matchStatus: status,
  };
}

describe('useUnclassified', () => {
  let testDb;

  beforeEach(async () => {
    testDb = getDb('test-unclassified-' + Date.now() + Math.random());
    await testDb.open();
  });

  afterEach(() => {
    cleanup();
  });

  it('returns rows with pending/failed/ambiguous matchStatus', async () => {
    await testDb.fileRefs.bulkPut([
      makeFileRef('a', 'matched', 'OK.mkv'),
      makeFileRef('b', 'pending', 'pending.mkv'),
      makeFileRef('c', 'failed', 'failed.mkv'),
      makeFileRef('d', 'ambiguous', 'ambiguous.mkv'),
      makeFileRef('e', 'manual', 'manual.mkv'),
    ]);

    render(<Probe db={testDb} />);

    await waitFor(() => {
      expect(screen.getByTestId('count').textContent).toBe('3');
    });

    const ids = screen.getAllByTestId('entry').map((n) => n.textContent.split('|')[0]);
    expect(ids.sort()).toEqual(['b', 'c', 'd']);
  });

  it('returns empty when nothing is unclassified', async () => {
    await testDb.fileRefs.put(makeFileRef('a', 'matched', 'OK.mkv'));
    render(<Probe db={testDb} />);
    await waitFor(() => {
      expect(screen.getByTestId('count').textContent).toBe('0');
    });
  });

  it('updates live when a row flips to matched', async () => {
    await testDb.fileRefs.put(makeFileRef('a', 'pending', 'A.mkv'));
    render(<Probe db={testDb} />);

    await waitFor(() => {
      expect(screen.getByTestId('count').textContent).toBe('1');
    });

    await testDb.fileRefs.update('a', { matchStatus: 'matched' });

    await waitFor(() => {
      expect(screen.getByTestId('count').textContent).toBe('0');
    });
  });

  it('sorts entries by relPath', async () => {
    await testDb.fileRefs.bulkPut([
      makeFileRef('z', 'failed', 'zeta.mkv'),
      makeFileRef('a', 'failed', 'alpha.mkv'),
      makeFileRef('m', 'failed', 'mu.mkv'),
    ]);
    render(<Probe db={testDb} />);

    await waitFor(() => {
      expect(screen.getByTestId('count').textContent).toBe('3');
    });

    const paths = screen
      .getAllByTestId('entry')
      .map((n) => n.textContent.split('|')[2]);
    expect(paths).toEqual(['alpha.mkv', 'mu.mkv', 'zeta.mkv']);
  });
});

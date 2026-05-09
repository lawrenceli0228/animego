import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, act, screen, cleanup, waitFor } from '@testing-library/react';
import { getDb } from '../lib/library/db/db.js';
import { makeProgressRepo } from '../lib/library/db/progressRepo.js';
import useSeriesProgressMap from '../hooks/useSeriesProgressMap.js';

function Probe({ db }) {
  const { map, loading } = useSeriesProgressMap({ db });
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="size">{map.size}</span>
      <ul>
        {Array.from(map.entries()).map(([id, info]) => (
          <li key={id} data-testid={`row-${id}`}>
            {`${id}|w=${info.watchedCount}|c=${info.completedCount}|t=${info.lastPlayedAt}`}
          </li>
        ))}
      </ul>
    </div>
  );
}

describe('useSeriesProgressMap', () => {
  let db;

  beforeEach(async () => {
    db = getDb('test-spm-' + Date.now() + Math.random());
    await db.open();
  });

  afterEach(() => {
    cleanup();
  });

  it('starts loading=true then resolves to an empty map', async () => {
    render(<Probe db={db} />);
    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });
    expect(screen.getByTestId('size').textContent).toBe('0');
  });

  it('aggregates watched and completed counts per series', async () => {
    const repo = makeProgressRepo(db);
    await repo.put({ episodeId: 'A1', seriesId: 'A', positionSec: 10, durationSec: 100, completed: true,  updatedAt: 100 });
    await repo.put({ episodeId: 'A2', seriesId: 'A', positionSec: 50, durationSec: 100, completed: false, updatedAt: 200 });
    await repo.put({ episodeId: 'B1', seriesId: 'B', positionSec: 80, durationSec: 100, completed: true,  updatedAt: 300 });

    render(<Probe db={db} />);
    await waitFor(() => {
      expect(screen.getByTestId('size').textContent).toBe('2');
    });
    expect(screen.getByTestId('row-A').textContent).toBe('A|w=2|c=1|t=200');
    expect(screen.getByTestId('row-B').textContent).toBe('B|w=1|c=1|t=300');
  });

  it('lastPlayedAt tracks the max updatedAt across that series', async () => {
    const repo = makeProgressRepo(db);
    await repo.put({ episodeId: 'A1', seriesId: 'A', positionSec: 10, durationSec: 100, completed: false, updatedAt: 500 });
    await repo.put({ episodeId: 'A2', seriesId: 'A', positionSec: 10, durationSec: 100, completed: false, updatedAt: 100 });

    render(<Probe db={db} />);
    await waitFor(() => {
      expect(screen.getByTestId('row-A').textContent).toBe('A|w=2|c=0|t=500');
    });
  });

  it('reacts to live writes', async () => {
    const repo = makeProgressRepo(db);

    render(<Probe db={db} />);
    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });
    expect(screen.getByTestId('size').textContent).toBe('0');

    await act(async () => {
      await repo.put({ episodeId: 'A1', seriesId: 'A', positionSec: 10, durationSec: 100, completed: false, updatedAt: 1 });
    });

    await waitFor(() => {
      expect(screen.getByTestId('size').textContent).toBe('1');
    });
  });
});

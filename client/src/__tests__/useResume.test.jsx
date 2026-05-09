import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, act, screen, cleanup, waitFor } from '@testing-library/react';
import { getDb } from '../lib/library/db/db.js';
import { makeProgressRepo } from '../lib/library/db/progressRepo.js';
import useResume from '../hooks/useResume.js';

function Probe({ db, limit }) {
  const { entries, loading } = useResume({ db, limit });
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="count">{entries.length}</span>
      <ul>
        {entries.map((e, i) => (
          <li key={i} data-testid="entry">
            {e.series.id}|{e.episodeNumber}|{e.lastTimeSec}
          </li>
        ))}
      </ul>
    </div>
  );
}

async function seedSeriesEpisode(db, { seriesId, animeId, epNum, episodeId, title = 'X' }) {
  await db.series.put({
    id: seriesId,
    titleZh: title,
    type: 'tv',
    confidence: 1,
    createdAt: 1,
    updatedAt: 1,
  });
  const seasonId = `${seriesId}:s1`;
  await db.seasons.put({ id: seasonId, seriesId, number: 1, animeId, updatedAt: 1 });
  await db.episodes.put({
    id: episodeId,
    seriesId,
    seasonId,
    number: epNum,
    kind: 'main',
    primaryFileId: 'fake',
    alternateFileIds: [],
    version: 1,
    updatedAt: 1,
  });
}

describe('useResume (P4-D)', () => {
  let testDb;

  beforeEach(async () => {
    testDb = getDb('test-resume-' + Date.now() + Math.random());
    await testDb.open();
  });

  afterEach(() => {
    cleanup();
  });

  it('starts loading then resolves to empty when no progress exists', async () => {
    render(<Probe db={testDb} />);
    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });
    expect(screen.getByTestId('count').textContent).toBe('0');
  });

  it('renders one entry per series, sorted by progress.updatedAt desc', async () => {
    const repo = makeProgressRepo(testDb);

    await seedSeriesEpisode(testDb, { seriesId: 'sr-A', animeId: 1, epNum: 3, episodeId: 'ep-A3' });
    await seedSeriesEpisode(testDb, { seriesId: 'sr-B', animeId: 2, epNum: 1, episodeId: 'ep-B1' });

    await repo.put({ episodeId: 'ep-A3', seriesId: 'sr-A', positionSec: 100, durationSec: 1440, completed: false, updatedAt: 1000 });
    await repo.put({ episodeId: 'ep-B1', seriesId: 'sr-B', positionSec: 50,  durationSec: 1440, completed: false, updatedAt: 2000 });

    render(<Probe db={testDb} />);

    await waitFor(() => {
      expect(screen.getByTestId('count').textContent).toBe('2');
    });
    const items = screen.getAllByTestId('entry').map(el => el.textContent);
    // sr-B is newer (updatedAt=2000) so it's first
    expect(items[0]).toBe('sr-B|1|50');
    expect(items[1]).toBe('sr-A|3|100');
  });

  it('hides episodes whose progress.completed is true', async () => {
    const repo = makeProgressRepo(testDb);

    await seedSeriesEpisode(testDb, { seriesId: 'sr-A', animeId: 1, epNum: 3, episodeId: 'ep-A3' });
    await repo.put({ episodeId: 'ep-A3', seriesId: 'sr-A', positionSec: 100, durationSec: 1440, completed: true, updatedAt: 1000 });

    render(<Probe db={testDb} />);
    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });
    expect(screen.getByTestId('count').textContent).toBe('0');
  });

  it('drops orphaned progress (series or episode no longer exists)', async () => {
    const repo = makeProgressRepo(testDb);
    // Note: we never seed series/episode here.
    await repo.put({ episodeId: 'ghost-ep', seriesId: 'ghost-sr', positionSec: 5, durationSec: 100, completed: false, updatedAt: 1 });

    render(<Probe db={testDb} />);
    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });
    expect(screen.getByTestId('count').textContent).toBe('0');
  });

  it('respects limit prop', async () => {
    const repo = makeProgressRepo(testDb);
    for (let i = 0; i < 5; i++) {
      await seedSeriesEpisode(testDb, {
        seriesId: `sr-${i}`,
        animeId: i + 100,
        epNum: 1,
        episodeId: `ep-${i}`,
      });
      await repo.put({
        episodeId: `ep-${i}`,
        seriesId: `sr-${i}`,
        positionSec: 10,
        durationSec: 100,
        completed: false,
        updatedAt: 1000 + i,
      });
    }
    render(<Probe db={testDb} limit={3} />);
    await waitFor(() => {
      expect(screen.getByTestId('count').textContent).toBe('3');
    });
    const items = screen.getAllByTestId('entry').map(el => el.textContent);
    expect(items.map(s => s.split('|')[0])).toEqual(['sr-4', 'sr-3', 'sr-2']);
  });

  it('reacts to progress writes (live)', async () => {
    const repo = makeProgressRepo(testDb);
    await seedSeriesEpisode(testDb, { seriesId: 'sr-A', animeId: 1, epNum: 1, episodeId: 'ep-A1' });

    render(<Probe db={testDb} />);
    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });
    expect(screen.getByTestId('count').textContent).toBe('0');

    await act(async () => {
      await repo.put({ episodeId: 'ep-A1', seriesId: 'sr-A', positionSec: 30, durationSec: 100, completed: false, updatedAt: 9000 });
    });

    await waitFor(() => {
      expect(screen.getByTestId('count').textContent).toBe('1');
    });
  });
});

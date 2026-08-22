import { beforeEach, describe, expect, test } from "bun:test";

import {
  EPISODE_COUNT_ID_CAP,
  backfillEpisodeCounts,
  chunkIds,
  collectBackfillIds,
  pickTotalEpisodes,
  resetEpisodeCountBackfillCache,
  type BackfillSeriesRow,
  type EpisodeCountItem,
} from "./episodeCountBackfill";

// ─── fakes ──────────────────────────────────────────────────────────────────

/** Records every write so a test can assert what did NOT get written too. */
function fakeDb() {
  const writes: { id: string; changes: Record<string, unknown> }[] = [];
  return {
    writes,
    db: {
      series: {
        update: async (id: string, changes: Record<string, unknown>) => {
          writes.push({ id, changes });
          return 1;
        },
      },
    },
  };
}

/**
 * A fake endpoint backed by a fixed catalog, recording every id list it was
 * asked for. Ids missing from the catalog are simply absent from the answer —
 * that is the real contract, and null-padding them would hide the branch this
 * module has to get right.
 */
function fakeEndpoint(catalog: Record<number, EpisodeCountItem>) {
  const calls: number[][] = [];
  const fetchCounts = async (ids: readonly number[]) => {
    calls.push([...ids]);
    return ids.map((id) => catalog[id]).filter((x): x is EpisodeCountItem => !!x);
  };
  return { calls, fetchCounts };
}

const bound = (
  id: string,
  anilistId: number,
  totalEpisodes?: number,
): BackfillSeriesRow => ({
  id,
  anilistId,
  ...(totalEpisodes === undefined ? {} : { totalEpisodes }),
});

beforeEach(() => {
  resetEpisodeCountBackfillCache();
});

// ─── pure pieces ────────────────────────────────────────────────────────────

describe("pickTotalEpisodes", () => {
  test("prefers AniList's authoritative count", () => {
    expect(pickTotalEpisodes(26, 24)).toBe(26);
  });

  test("falls back to the inferred count", () => {
    // The two stay two fields on the wire because only the authoritative one
    // may reach schema.org. A private local episode grid may use either.
    expect(pickTotalEpisodes(null, 24)).toBe(24);
    expect(pickTotalEpisodes(undefined, 24)).toBe(24);
  });

  test("neither present is 'unknown', never zero", () => {
    expect(pickTotalEpisodes(null, null)).toBeUndefined();
    expect(pickTotalEpisodes(0, 0)).toBeUndefined();
    expect(pickTotalEpisodes(-4, undefined)).toBeUndefined();
    expect(pickTotalEpisodes(12.5, undefined)).toBeUndefined();
  });
});

describe("collectBackfillIds", () => {
  test("asks only about series that are bound and have no total", () => {
    const ids = collectBackfillIds([
      bound("a", 1),
      bound("b", 2, 12), // already knows
      { id: "c" }, // unbound — nothing to ask with
      bound("d", 3),
    ]);
    expect(ids).toEqual([1, 3]);
  });

  test("a stored 0 counts as unknown and is asked about again", () => {
    expect(collectBackfillIds([bound("a", 1, 0)])).toEqual([1]);
  });

  test("de-duplicates ids two local rows happen to share", () => {
    // ANY() returns one row per matching row, not per array element, so a
    // duplicated id would make the answer shorter than the request — the exact
    // signal this module reserves for "not cached".
    expect(collectBackfillIds([bound("a", 7), bound("b", 7)])).toEqual([7]);
  });

  test("rejects ids that are not positive integers", () => {
    expect(
      collectBackfillIds([
        { id: "a", anilistId: 0 },
        { id: "b", anilistId: -1 },
        { id: "c", anilistId: 1.5 },
        { id: "d", anilistId: null },
      ]),
    ).toEqual([]);
  });

  test("skips ids the caller already knows are unanswerable", () => {
    expect(collectBackfillIds([bound("a", 1), bound("b", 2)], new Set([1]))).toEqual(
      [2],
    );
  });
});

describe("chunkIds", () => {
  test("the cap is the server's, and it is inclusive", () => {
    expect(EPISODE_COUNT_ID_CAP).toBe(200);
    const exact = chunkIds(Array.from({ length: 200 }, (_, i) => i + 1));
    expect(exact).toHaveLength(1);
    expect(exact[0]).toHaveLength(200);
  });

  test("one id over the cap splits rather than 400ing the whole call", () => {
    const chunks = chunkIds(Array.from({ length: 201 }, (_, i) => i + 1));
    expect(chunks.map((c) => c.length)).toEqual([200, 1]);
  });

  test("preserves order and loses nothing", () => {
    const ids = Array.from({ length: 450 }, (_, i) => i + 1);
    const chunks = chunkIds(ids);
    expect(chunks.map((c) => c.length)).toEqual([200, 200, 50]);
    expect(chunks.flat()).toEqual(ids);
  });

  test("an empty list produces no requests at all", () => {
    expect(chunkIds([])).toEqual([]);
  });
});

// ─── the runner ─────────────────────────────────────────────────────────────

describe("backfillEpisodeCounts — writing", () => {
  test("writes the count onto the series row", async () => {
    const { db, writes } = fakeDb();
    const { fetchCounts } = fakeEndpoint({
      1: { anilistId: 1, episodes: 26, episodesBgm: null },
    });
    const summary = await backfillEpisodeCounts({
      db,
      series: [bound("a", 1)],
      fetchCounts,
    });

    expect(writes).toEqual([{ id: "a", changes: { totalEpisodes: 26 } }]);
    expect(summary.written).toBe(1);
  });

  test("does not bump updatedAt", () => {
    // The "new additions" row sorts on it, and learning how long a show is is
    // not the user adding anything — writeBinding withholds it for the same
    // reason.
    const { db, writes } = fakeDb();
    return backfillEpisodeCounts({
      db,
      series: [bound("a", 1)],
      fetchCounts: fakeEndpoint({ 1: { anilistId: 1, episodes: 26 } }).fetchCounts,
    }).then(() => {
      expect(Object.keys(writes[0].changes)).toEqual(["totalEpisodes"]);
    });
  });

  test("answers every local row bound to the same id", async () => {
    const { db, writes } = fakeDb();
    const summary = await backfillEpisodeCounts({
      db,
      series: [bound("a", 7), bound("b", 7)],
      fetchCounts: fakeEndpoint({ 7: { anilistId: 7, episodes: 12 } }).fetchCounts,
    });
    expect(writes.map((w) => w.id).sort()).toEqual(["a", "b"]);
    expect(summary.written).toBe(2);
  });

  test("never writes a zero", async () => {
    // A cached row with no announced length. Absent and zero are the same fact
    // to every reader, and only one of them costs a write.
    const { db, writes } = fakeDb();
    const summary = await backfillEpisodeCounts({
      db,
      series: [bound("a", 1)],
      fetchCounts: fakeEndpoint({
        1: { anilistId: 1, episodes: null, episodesBgm: null },
      }).fetchCounts,
    });
    expect(writes).toEqual([]);
    expect(summary.unknown).toBe(1);
  });

  test("a write that throws does not abandon the rest of the chunk", async () => {
    const writes: string[] = [];
    const db = {
      series: {
        update: async (id: string) => {
          writes.push(id);
          if (id === "a") throw new Error("Dexie is having a day");
          return 1;
        },
      },
    };
    const summary = await backfillEpisodeCounts({
      db,
      series: [bound("a", 1), bound("b", 2)],
      fetchCounts: fakeEndpoint({
        1: { anilistId: 1, episodes: 12 },
        2: { anilistId: 2, episodes: 24 },
      }).fetchCounts,
    });
    expect(writes).toEqual(["a", "b"]);
    expect(summary.written).toBe(1);
  });
});

describe("backfillEpisodeCounts — chunking", () => {
  test("splits at the 200 cap and asks for every id exactly once", async () => {
    const { db } = fakeDb();
    const series = Array.from({ length: 201 }, (_, i) => bound(`s${i}`, i + 1));
    const { calls, fetchCounts } = fakeEndpoint({});

    await backfillEpisodeCounts({ db, series, fetchCounts });

    expect(calls.map((c) => c.length)).toEqual([200, 1]);
    expect(calls.flat()).toHaveLength(201);
    expect(new Set(calls.flat()).size).toBe(201);
  });

  test("asks nothing at all when there is nothing to ask about", async () => {
    const { db } = fakeDb();
    const { calls, fetchCounts } = fakeEndpoint({});
    const summary = await backfillEpisodeCounts({
      db,
      series: [bound("a", 1, 12), { id: "b" }],
      fetchCounts,
    });
    expect(calls).toEqual([]);
    expect(summary.requested).toBe(0);
  });
});

describe("backfillEpisodeCounts — ids the endpoint does not return", () => {
  test("an absent id writes nothing", async () => {
    // Absent means "not in the anime cache", which is a different fact from
    // "this show has zero episodes".
    const { db, writes } = fakeDb();
    const summary = await backfillEpisodeCounts({
      db,
      series: [bound("a", 1), bound("b", 2)],
      fetchCounts: fakeEndpoint({ 1: { anilistId: 1, episodes: 12 } }).fetchCounts,
    });
    expect(writes).toEqual([{ id: "a", changes: { totalEpisodes: 12 } }]);
    expect(summary.unknown).toBe(1);
  });

  test("an id that is never returned is not requested on later loads", async () => {
    // The trigger re-fires on every db.series write — import, rematch, metadata
    // refresh, and this module's own writes. Without the negative cache an id
    // the backend does not know would be re-requested on every emission for as
    // long as the tab is open.
    const { db } = fakeDb();
    const series = [bound("a", 1), bound("b", 2)];
    const { calls, fetchCounts } = fakeEndpoint({
      1: { anilistId: 1, episodes: 12 },
    });

    await backfillEpisodeCounts({ db, series, fetchCounts });
    // `a` still has no total in this fixture (the fake db does not write back),
    // so only the remembered miss can be what keeps id 2 out of the second call.
    await backfillEpisodeCounts({ db, series, fetchCounts });
    await backfillEpisodeCounts({ db, series, fetchCounts });

    expect(calls[0]).toEqual([1, 2]);
    expect(calls.slice(1).flat()).not.toContain(2);
  });

  test("a cached row with no count is remembered the same way", async () => {
    const { db } = fakeDb();
    const series = [bound("a", 1)];
    const { calls, fetchCounts } = fakeEndpoint({
      1: { anilistId: 1, episodes: null, episodesBgm: null },
    });

    await backfillEpisodeCounts({ db, series, fetchCounts });
    const second = await backfillEpisodeCounts({ db, series, fetchCounts });

    expect(calls).toHaveLength(1);
    expect(second.requested).toBe(0);
  });

  test("the miss is remembered per AniList id, not per series row", async () => {
    const { db } = fakeDb();
    const { calls, fetchCounts } = fakeEndpoint({});

    await backfillEpisodeCounts({ db, series: [bound("a", 9)], fetchCounts });
    // A second local row binds to the same unknown title — asking again would
    // learn nothing the first call did not already answer.
    await backfillEpisodeCounts({
      db,
      series: [bound("a", 9), bound("b", 9)],
      fetchCounts,
    });

    expect(calls).toHaveLength(1);
  });
});

describe("backfillEpisodeCounts — failure", () => {
  test("a failed chunk never throws at the caller", async () => {
    const { db } = fakeDb();
    const summary = await backfillEpisodeCounts({
      db,
      series: [bound("a", 1)],
      fetchCounts: async () => {
        throw new Error("offline");
      },
    });
    expect(summary.failedChunks).toBe(1);
    expect(summary.written).toBe(0);
  });

  test("a failed chunk does NOT latch its ids as unknown", async () => {
    // A dropped request is not an answer about these titles. Latching it would
    // disable the backfill for the whole session over one bad network moment —
    // the same rule resolveSeriesBinding applies to a failed search.
    const { db } = fakeDb();
    const series = [bound("a", 1)];
    let attempt = 0;
    const fetchCounts = async (ids: readonly number[]) => {
      attempt += 1;
      if (attempt === 1) throw new Error("offline");
      return ids.map((id) => ({ anilistId: id, episodes: 12 }));
    };

    await backfillEpisodeCounts({ db, series, fetchCounts });
    const second = await backfillEpisodeCounts({ db, series, fetchCounts });

    expect(second.written).toBe(1);
  });

  test("one failed chunk does not stop the next one", async () => {
    const { db, writes } = fakeDb();
    const series = Array.from({ length: 201 }, (_, i) => bound(`s${i}`, i + 1));
    let call = 0;
    const fetchCounts = async (ids: readonly number[]) => {
      call += 1;
      if (call === 1) throw new Error("offline");
      return ids.map((id) => ({ anilistId: id, episodes: 12 }));
    };

    const summary = await backfillEpisodeCounts({ db, series, fetchCounts });
    expect(summary.failedChunks).toBe(1);
    expect(writes).toHaveLength(1);
  });

  test("a database with no series table is a no-op, not a crash", async () => {
    const summary = await backfillEpisodeCounts({
      db: {} as never,
      series: [bound("a", 1)],
      fetchCounts: async () => [],
    });
    expect(summary.requested).toBe(0);
  });
});

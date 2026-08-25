import { beforeEach, describe, expect, test } from "bun:test";

import {
  backfillEpisodeOffsets,
  collectOffsetBackfillIds,
  resetEpisodeOffsetBackfillCache,
  type EpisodeOffsetDb,
  type EpisodeOffsetItem,
  type OffsetBackfillSeriesRow,
} from "./episodeOffsetBackfill";

// This sweep exists because `resolveSeriesBinding` only fetches an offset when
// it RESOLVES a binding, and returns early for a series already bound. Without
// it the cross-season fix reaches nobody who already had the affected series —
// which is everybody who could report it.
//
// The thing most worth pinning is the candidate predicate. `episodeOffset` is
// legitimately 0 for most of the catalogue ("nothing precedes this season"),
// so "already has one" has to be `typeof x === "number"`. Testing `x > 0`
// would leave every standalone series eligible forever and the sweep would
// never drain — the same stall migrations 0015 and 0023 hit server-side.

function fakeDb(): EpisodeOffsetDb & { updates: Array<[string, unknown]> } {
  const updates: Array<[string, unknown]> = [];
  return {
    updates,
    series: {
      async update(id: string, changes: Record<string, unknown>) {
        updates.push([id, changes]);
        return 1;
      },
    },
  };
}

const row = (
  id: string,
  anilistId: number | null,
  episodeOffset?: number | null,
): OffsetBackfillSeriesRow => ({ id, anilistId, episodeOffset });

beforeEach(() => {
  resetEpisodeOffsetBackfillCache();
});

describe("collectOffsetBackfillIds", () => {
  test("★ a stored offset of 0 is an ANSWER, not a missing value", () => {
    // The whole stall in one assertion. 0 is what most of the catalogue gets;
    // if it read as "still needs asking", every sweep would re-send the same
    // ids for the life of the library.
    expect(collectOffsetBackfillIds([row("A", 100, 0)])).toEqual([]);
  });

  test("a series with no offset is a candidate", () => {
    expect(collectOffsetBackfillIds([row("A", 100)])).toEqual([100]);
    expect(collectOffsetBackfillIds([row("A", 100, null)])).toEqual([100]);
  });

  test("a positive stored offset is also an answer", () => {
    expect(collectOffsetBackfillIds([row("A", 100, 28)])).toEqual([]);
  });

  test("an unbound series has nothing to ask with", () => {
    expect(collectOffsetBackfillIds([row("A", null)])).toEqual([]);
    expect(collectOffsetBackfillIds([row("A", 0)])).toEqual([]);
  });

  test("one id per title even when two local rows share it", () => {
    expect(collectOffsetBackfillIds([row("A", 100), row("B", 100)])).toEqual([100]);
  });

  test("ids answered unknown earlier this session are dropped before the request", () => {
    expect(collectOffsetBackfillIds([row("A", 100)], new Set([100]))).toEqual([]);
  });
});

describe("backfillEpisodeOffsets", () => {
  test("★ writes the offset to every series bound to the id, including 0", async () => {
    const db = fakeDb();
    const summary = await backfillEpisodeOffsets({
      db,
      series: [row("A", 182255), row("B", 130003), row("C", 182255)],
      fetchOffsets: async (): Promise<EpisodeOffsetItem[]> => [
        { anilistId: 182255, known: true, offset: 28 },
        // The standalone case. It has to be stored, not skipped — storing it
        // is what stops the grid inferring a shift for a season that has
        // nothing before it.
        { anilistId: 130003, known: true, offset: 0 },
      ],
    });

    expect(db.updates).toEqual([
      ["A", { episodeOffset: 28 }],
      ["C", { episodeOffset: 28 }],
      ["B", { episodeOffset: 0 }],
    ]);
    expect(summary.written).toBe(3);
    expect(summary.unknown).toBe(0);
  });

  test("known:false is latched, so the next sweep does not re-ask", async () => {
    const db = fakeDb();
    const series = [row("A", 999)];
    let calls = 0;
    const fetchOffsets = async (): Promise<EpisodeOffsetItem[]> => {
      calls += 1;
      return [{ anilistId: 999, known: false, offset: 0 }];
    };

    const first = await backfillEpisodeOffsets({ db, series, fetchOffsets });
    expect(first.unknown).toBe(1);
    expect(db.updates).toEqual([]);

    await backfillEpisodeOffsets({ db, series, fetchOffsets });
    expect(calls).toBe(1);
  });

  test("★ an id the server returned NO row for is latched too", async () => {
    // Absent and known:false mean the same thing — the anchor is not in the
    // cache. Latching only the explicit refusals would leave the silent ones
    // re-asked on every sweep, which is the same stall wearing a quieter hat.
    const db = fakeDb();
    const series = [row("A", 777)];
    let calls = 0;
    const fetchOffsets = async (): Promise<EpisodeOffsetItem[]> => {
      calls += 1;
      return [];
    };

    const first = await backfillEpisodeOffsets({ db, series, fetchOffsets });
    expect(first.unknown).toBe(1);

    await backfillEpisodeOffsets({ db, series, fetchOffsets });
    expect(calls).toBe(1);
  });

  test("★ a FAILED request is not latched — it is not an answer about the title", async () => {
    const db = fakeDb();
    const series = [row("A", 555)];
    let calls = 0;
    const fetchOffsets = async (): Promise<EpisodeOffsetItem[]> => {
      calls += 1;
      if (calls === 1) throw new Error("network");
      return [{ anilistId: 555, known: true, offset: 12 }];
    };

    const first = await backfillEpisodeOffsets({ db, series, fetchOffsets });
    expect(first.failedChunks).toBe(1);
    expect(first.written).toBe(0);

    // Latching a flaky moment would cost the whole sweep for the session.
    const second = await backfillEpisodeOffsets({ db, series, fetchOffsets });
    expect(second.written).toBe(1);
    expect(db.updates).toEqual([["A", { episodeOffset: 12 }]]);
  });

  test("never throws, and a write failure does not take the sweep down", async () => {
    const db = {
      updates: [] as Array<[string, unknown]>,
      series: {
        async update(id: string) {
          if (id === "A") throw new Error("dexie");
          db.updates.push([id, {}]);
          return 1;
        },
      },
    } as unknown as EpisodeOffsetDb & { updates: Array<[string, unknown]> };

    const summary = await backfillEpisodeOffsets({
      db,
      series: [row("A", 1), row("B", 2)],
      fetchOffsets: async (): Promise<EpisodeOffsetItem[]> => [
        { anilistId: 1, known: true, offset: 5 },
        { anilistId: 2, known: true, offset: 6 },
      ],
    });

    expect(summary.written).toBe(1);
  });

  test("no candidates means no request at all", async () => {
    let calls = 0;
    const summary = await backfillEpisodeOffsets({
      db: fakeDb(),
      series: [row("A", 100, 0), row("B", 200, 28)],
      fetchOffsets: async () => {
        calls += 1;
        return [];
      },
    });
    expect(calls).toBe(0);
    expect(summary.asked).toBe(0);
  });
});

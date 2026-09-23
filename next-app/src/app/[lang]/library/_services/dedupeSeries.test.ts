import { describe, expect, test } from "bun:test";

import {
  dedupeSeriesByIdentity,
  identityKeyFor,
  wasDeliberatelySplit,
} from "./dedupeSeries";
import { mergedAwayIds, resolveMergedSeriesIds } from "./resolveMergedIds";

// Grouping duplicate cards, after #105 took away the key this used to use.
//
// It grouped on `Season.animeId` alone. #105 removed the fallback that filled
// that field — the value was a bgm.tv subject id in a dandanplay-shaped column
// — and correctly so, but it left this pass with nothing to group by for any
// automatically imported series. Duplicate cards stopped meeting each other
// and the file's own header said so.
//
// The two properties worth pinning hardest are not "does it merge":
//
//   1. THE TWO ID SPACES MUST NOT SHARE A KEY. AniList 806 and dandanplay 806
//      are different shows and both endpoints answer 200 for their own. A
//      numeric map merges them with total confidence — the same collision
//      #105's branded types exist to stop one layer down.
//   2. A DELIBERATE SPLIT MUST SURVIVE. An automatic pass that undoes a
//      manual one is worse than no automatic pass, because the reader has no
//      way to make it stop.

interface FakeRow {
  [key: string]: unknown;
}

/**
 * Enough Dexie for this module and for `performMerge` beneath it: table reads,
 * `userOverride` get/put, and an `opsLog` that records appends. `transaction`
 * runs the body directly — there is no concurrency here to serialise.
 */
function fakeDb(seed: {
  series: FakeRow[];
  seasons?: FakeRow[];
  userOverride?: FakeRow[];
}) {
  const series = [...seed.series];
  const seasons = [...(seed.seasons ?? [])];
  const userOverride = [...(seed.userOverride ?? [])];
  const opsLog: FakeRow[] = [];

  const table = (rows: FakeRow[], key: string) => ({
    toArray: async () => rows.slice(),
    get: async (id: string) => rows.find((r) => r[key] === id) ?? undefined,
    put: async (row: FakeRow) => {
      const i = rows.findIndex((r) => r[key] === row[key]);
      if (i >= 0) rows[i] = row;
      else rows.push(row);
      return row[key];
    },
    delete: async (id: string) => {
      const i = rows.findIndex((r) => r[key] === id);
      if (i >= 0) rows.splice(i, 1);
    },
  });

  return {
    series: table(series, "id"),
    seasons: table(seasons, "id"),
    userOverride: table(userOverride, "seriesId"),
    opsLog: table(opsLog, "id"),
    transaction: async (_mode: string, _t: unknown, fn: () => Promise<unknown>) => fn(),
    _rows: { series, seasons, userOverride, opsLog },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/**
 * The cards the grid would draw, oldest-first by id — useLibrary's own rule
 * (`mergedAwayIds`), not a re-statement of it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function visibleIds(db: any): string[] {
  const hidden = mergedAwayIds(db._rows.userOverride);
  return (db._rows.series as FakeRow[])
    .map((row) => row.id as string)
    .filter((id) => !hidden.has(id))
    .sort();
}

/** Typed, not FakeRow: `identityKeyFor` takes a real shape and the compiler
 *  should say so if that shape moves. */
const s = (
  id: string,
  createdAt: number,
  anilistId?: number | null,
): { id: string; createdAt: number; anilistId?: number | null } => ({
  id,
  createdAt,
  ...(anilistId === undefined ? {} : { anilistId }),
});

describe("identityKeyFor", () => {
  const noSeasons = new Map<string, FakeRow[]>();

  test("★ the two id spaces get different keys for the same number", () => {
    // The collision that would merge two unrelated shows. 806 is a real anime
    // in both spaces and both APIs answer 200 for it — a numeric map cannot
    // tell them apart, and a namespaced string cannot confuse them.
    const byAnilist = identityKeyFor(s("A", 0, 806), noSeasons);
    const byDandan = identityKeyFor(
      s("B", 0),
      new Map([["B", [{ seriesId: "B", animeId: 806, number: 1 }]]]),
    );
    expect(byAnilist).toBe("anilist:806");
    expect(byDandan).toBe("dandan:806");
    expect(byAnilist).not.toBe(byDandan);
  });

  test("AniList wins when both are present", () => {
    // The id every other surface keys on, the one the binding sweep writes,
    // and the one that survives a rematch changing the dandanplay side.
    expect(
      identityKeyFor(
        s("A", 0, 130003),
        new Map([["A", [{ seriesId: "A", animeId: 999, number: 1 }]]]),
      ),
    ).toBe("anilist:130003");
  });

  test("falls back to the LOWEST-numbered season's animeId", () => {
    // Same "primary season" rule seriesGroups uses, so two passes over one
    // library cannot disagree about which season speaks for a card.
    expect(
      identityKeyFor(
        s("A", 0),
        new Map([
          [
            "A",
            [
              { seriesId: "A", animeId: 500, number: 2 },
              { seriesId: "A", animeId: 400, number: 1 },
            ],
          ],
        ]),
      ),
    ).toBe("dandan:400");
  });

  test("no usable id anywhere is null, not a key", () => {
    expect(identityKeyFor(s("A", 0), noSeasons)).toBeNull();
    expect(identityKeyFor(s("A", 0, null), noSeasons)).toBeNull();
    expect(identityKeyFor(s("A", 0, 0), noSeasons)).toBeNull();
    expect(
      identityKeyFor(s("A", 0), new Map([["A", [{ seriesId: "A", animeId: 0 }]]])),
    ).toBeNull();
  });
});

describe("wasDeliberatelySplit", () => {
  test("★ the lineage is one-directional and checked both ways", () => {
    // splitSeries records `splitFrom` on the NEW row only. Checking one
    // direction would let the pair re-merge depending on which of the two
    // happens to be older.
    const splitFrom = new Map([["B", "A"]]);
    expect(wasDeliberatelySplit("A", "B", splitFrom)).toBe(true);
    expect(wasDeliberatelySplit("B", "A", splitFrom)).toBe(true);
    expect(wasDeliberatelySplit("A", "C", splitFrom)).toBe(false);
  });
});

describe("dedupeSeriesByIdentity", () => {
  test("★ two rows bound to the same AniList id become one card", () => {
    // The case that stopped working: neither row has a Season.animeId, which
    // is every automatically imported series after #105.
    const db = fakeDb({ series: [s("A", 100, 130003), s("B", 200, 130003)] });
    return dedupeSeriesByIdentity({ db }).then((summary) => {
      expect(summary.groups).toBe(1);
      expect(summary.merged).toBe(1);
      expect(summary.pairs).toEqual([
        { sourceSeriesId: "B", targetSeriesId: "A", identity: "anilist:130003" },
      ]);
    });
  });

  test("★ an AniList id and a dandanplay id that happen to match are NOT merged", async () => {
    const db = fakeDb({
      series: [s("A", 100, 806), s("B", 200)],
      seasons: [{ id: "se1", seriesId: "B", animeId: 806, number: 1 }],
    });
    const summary = await dedupeSeriesByIdentity({ db });
    expect(summary.groups).toBe(0);
    expect(summary.merged).toBe(0);
  });

  test("★ a pair the reader split apart is left alone", async () => {
    const db = fakeDb({
      series: [s("A", 100, 130003), s("B", 200, 130003)],
      userOverride: [{ seriesId: "B", splitFrom: "A" }],
    });
    const summary = await dedupeSeriesByIdentity({ db });
    expect(summary.groups).toBe(1);
    expect(summary.merged).toBe(0);
    expect(summary.splitGuarded).toBe(1);
    expect(summary.pairs).toEqual([]);
  });

  test("the oldest row is the target, so the long-standing card keeps its place", async () => {
    const db = fakeDb({ series: [s("new", 900, 1), s("old", 100, 1), s("mid", 500, 1)] });
    const summary = await dedupeSeriesByIdentity({ db });
    expect(summary.pairs.map((p) => p.targetSeriesId)).toEqual(["old", "old"]);
    expect(summary.pairs.map((p) => p.sourceSeriesId).sort()).toEqual(["mid", "new"]);
  });

  test("a series with no identity is not grouped with other id-less rows", async () => {
    // The trap a `?? 0` key would create: every unbound series folding into
    // one card. They are not the same show, they are unidentified.
    const db = fakeDb({ series: [s("A", 100), s("B", 200), s("C", 300)] });
    const summary = await dedupeSeriesByIdentity({ db });
    expect(summary.groups).toBe(0);
    expect(summary.merged).toBe(0);
  });

  test("a lone row is not a group", async () => {
    const db = fakeDb({ series: [s("A", 100, 130003), s("B", 200, 999)] });
    const summary = await dedupeSeriesByIdentity({ db });
    expect(summary.groups).toBe(0);
  });

  test("running twice merges nothing the second time", async () => {
    // performMerge no-ops on a pair already in `mergedFrom`, so the pass is
    // idempotent — which is what lets it run automatically at all.
    const db = fakeDb({ series: [s("A", 100, 130003), s("B", 200, 130003)] });
    expect((await dedupeSeriesByIdentity({ db })).merged).toBe(1);
    const second = await dedupeSeriesByIdentity({ db });
    expect(second.merged).toBe(0);
    expect(second.skipped).toBe(1);
  });

  // ─── merge cycles: the "merging made everything disappear" bug ─────────────
  //
  // The sweep targets the OLDEST row and reads every series, merged-in ones
  // included. A reader who had merged the older card into the newer one by
  // hand got that merge reversed on their next visit — B held A, then A held
  // B — and useLibrary hides every id that appears in any `mergedFrom`, so
  // both cards vanished with every episode under them.

  test("★ a reader's older→newer merge is not reversed into a cycle", async () => {
    const db = fakeDb({
      series: [s("A", 100, 130003), s("B", 200, 130003)],
      userOverride: [{ seriesId: "B", mergedFrom: ["A"], updatedAt: 300 }],
    });
    const summary = await dedupeSeriesByIdentity({ db });
    expect(summary.merged).toBe(0);
    expect(visibleIds(db)).toEqual(["B"]);
    expect(resolveMergedSeriesIds(db._rows.userOverride, "B")).toEqual(["B", "A"]);
  });

  test("★ a cycle already on disk is repaired, and the reader's choice wins", async () => {
    // What an affected library looks like today: B.mergedFrom=[A] written by
    // the reader, A.mergedFrom=[B] written later by the sweep. Zero cards.
    const db = fakeDb({
      series: [s("A", 100, 130003), s("B", 200, 130003)],
      userOverride: [
        { seriesId: "B", mergedFrom: ["A"], updatedAt: 300 },
        { seriesId: "A", mergedFrom: ["B"], updatedAt: 400 },
      ],
    });
    expect(visibleIds(db)).toEqual([]);

    const summary = await dedupeSeriesByIdentity({ db });
    expect(summary.cyclesRepaired).toBe(1);
    expect(visibleIds(db)).toEqual(["B"]);
    expect(resolveMergedSeriesIds(db._rows.userOverride, "B")).toEqual(["B", "A"]);

    // And the sweep does not immediately put it back.
    const again = await dedupeSeriesByIdentity({ db });
    expect(again.cyclesRepaired).toBe(0);
    expect(visibleIds(db)).toEqual(["B"]);
  });

  test("★ three copies, one already merged by hand, end as ONE card holding all three", async () => {
    const db = fakeDb({
      series: [s("A", 100, 1), s("B", 200, 1), s("C", 300, 1)],
      userOverride: [{ seriesId: "C", mergedFrom: ["A"], updatedAt: 400 }],
    });
    await dedupeSeriesByIdentity({ db });
    const visible = visibleIds(db);
    expect(visible).toHaveLength(1);
    expect(resolveMergedSeriesIds(db._rows.userOverride, visible[0]).sort()).toEqual([
      "A",
      "B",
      "C",
    ]);
  });

  test("records an opsLog row per merge, so it can be undone", async () => {
    const db = fakeDb({ series: [s("A", 100, 130003), s("B", 200, 130003)] });
    const summary = await dedupeSeriesByIdentity({ db });
    expect(summary.opIds).toHaveLength(1);
    expect(db._rows.opsLog).toHaveLength(1);
    expect(db._rows.opsLog[0].kind).toBe("merge");
  });
});

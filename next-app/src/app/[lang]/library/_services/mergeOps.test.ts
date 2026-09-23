import { describe, expect, test } from "bun:test";

import { performMerge } from "./mergeOps";

// performMerge is the one write path every merge goes through — the card
// menu, the bulk toolbar, the series page and the duplicate sweep. The cycle
// guard lives here so that none of them can hide a pair of cards from each
// other, rather than each caller having to remember to check.

interface FakeRow {
  [key: string]: unknown;
}

function fakeDb(userOverride: FakeRow[] = []) {
  const rows = { userOverride: [...userOverride], opsLog: [] as FakeRow[] };
  const table = (list: FakeRow[], key: string) => ({
    toArray: async () => list.slice(),
    get: async (id: string) => list.find((r) => r[key] === id) ?? undefined,
    put: async (row: FakeRow) => {
      const i = list.findIndex((r) => r[key] === row[key]);
      if (i >= 0) list[i] = row;
      else list.push(row);
      return row[key];
    },
  });
  return {
    userOverride: table(rows.userOverride, "seriesId"),
    opsLog: table(rows.opsLog, "id"),
    transaction: async (_mode: string, _t: unknown, fn: () => Promise<unknown>) => fn(),
    _rows: rows,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("performMerge", () => {
  test("appends the source to the target's mergedFrom and logs it", async () => {
    const db = fakeDb();
    const op = await performMerge({ db, sourceSeriesId: "A", targetSeriesId: "B" });
    expect(op?.kind).toBe("merge");
    expect(db._rows.userOverride).toEqual([
      expect.objectContaining({ seriesId: "B", mergedFrom: ["A"] }),
    ]);
  });

  test("★ refuses a merge that would put two cards inside each other", async () => {
    const db = fakeDb([{ seriesId: "B", mergedFrom: ["A"], updatedAt: 1 }]);
    const op = await performMerge({ db, sourceSeriesId: "B", targetSeriesId: "A" });
    expect(op).toBeNull();
    expect(db._rows.userOverride).toEqual([
      { seriesId: "B", mergedFrom: ["A"], updatedAt: 1 },
    ]);
    expect(db._rows.opsLog).toEqual([]);
  });

  test("refuses one that closes a longer loop", async () => {
    const db = fakeDb([
      { seriesId: "C", mergedFrom: ["B"] },
      { seriesId: "B", mergedFrom: ["A"] },
    ]);
    expect(
      await performMerge({ db, sourceSeriesId: "C", targetSeriesId: "A" }),
    ).toBeNull();
    expect(db._rows.opsLog).toEqual([]);
  });

  test("a repeat of an existing merge is still a quiet no-op", async () => {
    const db = fakeDb([{ seriesId: "B", mergedFrom: ["A"] }]);
    expect(
      await performMerge({ db, sourceSeriesId: "A", targetSeriesId: "B" }),
    ).toBeNull();
  });
});

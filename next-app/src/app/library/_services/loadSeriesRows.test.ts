import { describe, expect, test } from "bun:test";

import { loadMergedSeriesRows } from "./loadSeriesRows";

interface Ep {
  id: string;
  seriesId: string;
  number: number;
}
interface Prog {
  episodeId: string;
  seriesId: string;
}

interface Call {
  table: string;
  index: string;
  method: "anyOf" | "equals";
  values: string[];
}

/**
 * Fake Dexie that RECORDS how it was queried.
 *
 * The recording is the point. A fake that merely returns the right rows would
 * pass just as happily against the broken `.equals(series.id)` version — the
 * regression was never about which rows came back from a stub, it was about
 * which query the component asked for. `equals` is present and throws so a
 * revert fails loudly instead of quietly returning a subset.
 */
function fakeDb(opts: {
  overrides?: { seriesId?: string; mergedFrom?: string[] }[] | null;
  episodes?: Ep[];
  progress?: Prog[];
  noOverrideTable?: boolean;
}) {
  const calls: Call[] = [];
  const episodes = opts.episodes ?? [];
  const progress = opts.progress ?? [];

  function table<T extends { seriesId: string }>(name: string, rows: T[]) {
    return {
      where(index: string) {
        return {
          anyOf(values: readonly string[]) {
            calls.push({ table: name, index, method: "anyOf", values: [...values] });
            const set = new Set(values);
            return { toArray: async () => rows.filter((r) => set.has(r.seriesId)) };
          },
          equals(value: string) {
            calls.push({ table: name, index, method: "equals", values: [value] });
            throw new Error(
              `${name}.equals() is the regression this module exists to prevent`,
            );
          },
        };
      },
    };
  }

  return {
    calls,
    db: {
      episodes: table("episodes", episodes),
      progress: table("progress", progress),
      ...(opts.noOverrideTable
        ? {}
        : { userOverride: { toArray: async () => opts.overrides ?? [] } }),
    },
  };
}

describe("loadMergedSeriesRows", () => {
  test("queries with anyOf, never equals", async () => {
    const { db, calls } = fakeDb({ overrides: [] });
    await loadMergedSeriesRows(db as never, "B");
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.method === "anyOf")).toBe(true);
  });

  test("queries both tables on the seriesId index", async () => {
    const { db, calls } = fakeDb({ overrides: [] });
    await loadMergedSeriesRows(db as never, "B");
    expect(calls.map((c) => c.table).sort()).toEqual(["episodes", "progress"]);
    expect(calls.every((c) => c.index === "seriesId")).toBe(true);
  });

  // The reported bug, end to end: A merged into B, open B, see both halves.
  test("returns episodes from the merged source as well as the target", async () => {
    const { db } = fakeDb({
      overrides: [{ seriesId: "B", mergedFrom: ["A"] }],
      episodes: [
        { id: "b1", seriesId: "B", number: 1 },
        { id: "b2", seriesId: "B", number: 2 },
        { id: "a1", seriesId: "A", number: 3 },
        { id: "z1", seriesId: "Z", number: 9 },
      ],
    });
    const out = await loadMergedSeriesRows<Ep, Prog>(db as never, "B");
    expect(out.episodes.map((e) => e.id).sort()).toEqual(["a1", "b1", "b2"]);
    expect(out.seriesIds).toEqual(["B", "A"]);
  });

  // The quiet half. Episodes appearing while their progress does not looks
  // like deleted watch history, not like a query bug, so it is the version of
  // this mistake most likely to survive a manual smoke test.
  test("carries progress rows for the merged source too", async () => {
    const { db, calls } = fakeDb({
      overrides: [{ seriesId: "B", mergedFrom: ["A"] }],
      progress: [
        { episodeId: "b1", seriesId: "B" },
        { episodeId: "a1", seriesId: "A" },
      ],
    });
    const out = await loadMergedSeriesRows<Ep, Prog>(db as never, "B");
    expect(out.progress.map((p) => p.episodeId).sort()).toEqual(["a1", "b1"]);

    // Same id set for both tables — a narrower progress query is exactly the
    // asymmetry that produces "my episodes are back but unwatched".
    const [ep] = calls.filter((c) => c.table === "episodes");
    const [pr] = calls.filter((c) => c.table === "progress");
    expect(pr.values).toEqual(ep.values);
  });

  test("follows a merge chain (A into B, then B into C)", async () => {
    const { db } = fakeDb({
      overrides: [
        { seriesId: "C", mergedFrom: ["B"] },
        { seriesId: "B", mergedFrom: ["A"] },
      ],
      episodes: [
        { id: "c1", seriesId: "C", number: 1 },
        { id: "b1", seriesId: "B", number: 2 },
        { id: "a1", seriesId: "A", number: 3 },
      ],
    });
    const out = await loadMergedSeriesRows<Ep, Prog>(db as never, "C");
    expect(out.seriesIds).toEqual(["C", "B", "A"]);
    expect(out.episodes).toHaveLength(3);
    // v6: episodes aggregate across every contributor, but only the root owns
    // the AniList binding — sync must push against C, never B or A.
    expect(out.rootSeriesId).toBe("C");
  });

  test("returns only the series' own rows when nothing was merged", async () => {
    const { db } = fakeDb({
      overrides: [],
      episodes: [
        { id: "b1", seriesId: "B", number: 1 },
        { id: "a1", seriesId: "A", number: 1 },
      ],
    });
    const out = await loadMergedSeriesRows<Ep, Prog>(db as never, "B");
    expect(out.episodes.map((e) => e.id)).toEqual(["b1"]);
    expect(out.seriesIds).toEqual(["B"]);
  });

  // Opening a source directly must not pull in its target's other sources.
  test("does not walk upward from a merged source", async () => {
    const { db } = fakeDb({
      overrides: [{ seriesId: "C", mergedFrom: ["A", "B"] }],
      episodes: [
        { id: "a1", seriesId: "A", number: 1 },
        { id: "b1", seriesId: "B", number: 1 },
      ],
    });
    const out = await loadMergedSeriesRows<Ep, Prog>(db as never, "B");
    expect(out.episodes.map((e) => e.id)).toEqual(["b1"]);
  });

  test("survives a database with no userOverride table", async () => {
    const { db } = fakeDb({
      noOverrideTable: true,
      episodes: [{ id: "b1", seriesId: "B", number: 1 }],
    });
    const out = await loadMergedSeriesRows<Ep, Prog>(db as never, "B");
    expect(out.seriesIds).toEqual(["B"]);
    expect(out.episodes).toHaveLength(1);
  });

  test("short-circuits on an empty series id without touching the db", async () => {
    const { db, calls } = fakeDb({ overrides: [] });
    const out = await loadMergedSeriesRows<Ep, Prog>(db as never, "");
    expect(out).toEqual({
      seriesIds: [],
      rootSeriesId: "",
      episodes: [],
      progress: [],
    });
    expect(calls).toHaveLength(0);
  });
});

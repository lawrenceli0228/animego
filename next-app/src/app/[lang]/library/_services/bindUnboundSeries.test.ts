import { beforeEach, describe, expect, test } from "bun:test";

import {
  BIND_SWEEP_CAP,
  bindUnboundSeries,
  collectUnboundSeries,
  countUnboundSeries,
  type SweepSeriesRow,
} from "./bindUnboundSeries";
import {
  resetSeriesBindingCache,
  type SeriesSearchFn,
} from "./resolveSeriesBinding";

// ─── fakes ──────────────────────────────────────────────────────────────────

interface FakeSeries extends SweepSeriesRow {
  anilistId?: number | null;
}

function fakeDb(rows: FakeSeries[]) {
  const writes: { id: string; changes: Record<string, unknown> }[] = [];
  return {
    writes,
    rows,
    series: {
      get: async (id: string) => rows.find((r) => r.id === id),
      update: async (id: string, changes: Record<string, unknown>) => {
        writes.push({ id, changes });
        const row = rows.find((r) => r.id === id);
        if (row) Object.assign(row, changes);
        return 1;
      },
    },
    userOverride: {
      get: async () => undefined,
      put: async () => 1,
    },
  };
}

function fakeOpsLog() {
  const entries: Record<string, unknown>[] = [];
  return {
    entries,
    append: async (entry: Record<string, unknown>) => {
      entries.push(entry);
      return entry;
    },
  };
}

/** A search that answers with one animeCache hit whose title equals the query. */
function matchingSearch(anilistIdFor: (kw: string) => number): SeriesSearchFn {
  return async (keyword: string) => ({
    results: [
      {
        source: "animeCache",
        anilistId: anilistIdFor(keyword),
        titleChinese: keyword,
        episodes: 12,
      },
    ],
  });
}

/** A search that answers, but with nothing the matcher will accept. */
const emptySearch: SeriesSearchFn = async () => ({ results: [] });

/** A search that fails at the transport level. */
const failingSearch: SeriesSearchFn = async () => {
  throw new Error("network down");
};

beforeEach(() => {
  resetSeriesBindingCache();
});

// ─── collectUnboundSeries ───────────────────────────────────────────────────

describe("collectUnboundSeries", () => {
  test("picks rows that have a title and no binding", () => {
    const picked = collectUnboundSeries([
      { id: "a", titleZh: "间谍过家家" },
      { id: "b", titleZh: "已绑定的", anilistId: 123 },
      { id: "c", titleEn: "Frieren" },
    ]);
    expect(picked.map((r) => r.id)).toEqual(["a", "c"]);
  });

  test("a bound row is never a candidate, whatever its title says", () => {
    expect(collectUnboundSeries([{ id: "a", titleZh: "x", anilistId: 1 }])).toEqual([]);
  });

  test("treats a non-positive anilistId as unbound rather than bound", () => {
    // 0 and null both mean "no binding" everywhere else in this tree; a row
    // carrying one must stay eligible or it would be stranded forever.
    const picked = collectUnboundSeries([
      { id: "a", titleZh: "x", anilistId: 0 },
      { id: "b", titleZh: "y", anilistId: null },
    ]);
    expect(picked.map((r) => r.id)).toEqual(["a", "b"]);
  });

  test("★ drops a row with no usable title — the loop would never terminate otherwise", () => {
    // resolveSeriesBinding returns early for an empty keyword WITHOUT latching
    // anything, because it never asked and so learned nothing. If such a row
    // stayed a candidate it would be re-picked on every liveQuery emission for
    // as long as the tab is open. Real libraries hold these: a folder name that
    // parsed down to a fansub group leaves a row with no usable title.
    expect(collectUnboundSeries([{ id: "a" }])).toEqual([]);
    expect(collectUnboundSeries([{ id: "a", titleZh: "" }])).toEqual([]);
  });

  test("skips rows with no id — there is nothing to write back to", () => {
    expect(collectUnboundSeries([{ titleZh: "x" }])).toEqual([]);
  });

  test("honours the cap and keeps input order", () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: `s${i}`,
      titleZh: `t${i}`,
    }));
    expect(collectUnboundSeries(rows, 2).map((r) => r.id)).toEqual(["s0", "s1"]);
  });

  test("falls back to the default cap on a nonsense one", () => {
    const rows = Array.from({ length: BIND_SWEEP_CAP + 5 }, (_, i) => ({
      id: `s${i}`,
      titleZh: `t${i}`,
    }));
    expect(collectUnboundSeries(rows, 0)).toHaveLength(BIND_SWEEP_CAP);
    expect(collectUnboundSeries(rows, -1)).toHaveLength(BIND_SWEEP_CAP);
  });

  test("tolerates null, undefined and holes in the list", () => {
    const rows = [null, undefined, { id: "a", titleZh: "x" }] as SweepSeriesRow[];
    expect(collectUnboundSeries(rows).map((r) => r.id)).toEqual(["a"]);
    expect(collectUnboundSeries(null)).toEqual([]);
    expect(collectUnboundSeries(undefined)).toEqual([]);
  });

  test("countUnboundSeries ignores the cap", () => {
    const rows = Array.from({ length: BIND_SWEEP_CAP + 7 }, (_, i) => ({
      id: `s${i}`,
      titleZh: `t${i}`,
    }));
    expect(countUnboundSeries(rows)).toBe(BIND_SWEEP_CAP + 7);
  });
});

// ─── bindUnboundSeries ──────────────────────────────────────────────────────

describe("bindUnboundSeries", () => {
  test("binds every unbound series that resolves", async () => {
    const db = fakeDb([
      { id: "a", titleZh: "间谍过家家" },
      { id: "b", titleZh: "葬送的芙莉莲" },
    ]);
    const summary = await bindUnboundSeries({
      db,
      series: db.rows,
      search: matchingSearch((kw) => (kw === "间谍过家家" ? 111 : 222)),
      delayMs: 0,
    });

    expect(summary.bound).toBe(2);
    expect(summary.attempted).toBe(2);
    expect(summary.changed).toBe(true);
    expect(db.rows.find((r) => r.id === "a")?.anilistId).toBe(111);
    expect(db.rows.find((r) => r.id === "b")?.anilistId).toBe(222);
  });

  test("★ a second pass over the same rows does no work at all", async () => {
    // This is the convergence property. The candidate set is derived from the
    // rows, so a series that got bound drops out — which is what stops the
    // liveQuery that this sweep's own writes re-trigger from looping.
    const db = fakeDb([{ id: "a", titleZh: "间谍过家家" }]);
    let searches = 0;
    const counting: SeriesSearchFn = async (kw) => {
      searches += 1;
      return matchingSearch(() => 111)(kw);
    };

    await bindUnboundSeries({ db, series: db.rows, search: counting, delayMs: 0 });
    const second = await bindUnboundSeries({
      db,
      series: db.rows,
      search: counting,
      delayMs: 0,
    });

    expect(searches).toBe(1);
    expect(second.attempted).toBe(0);
    expect(second.candidates).toBe(0);
    expect(second.changed).toBe(false);
  });

  test("★ an unmatchable title is searched once per session, not once per pass", async () => {
    // The negative latch lives in resolveSeriesBinding's `_unresolved`. Without
    // it, an unmatchable title is re-searched on every emission forever.
    const db = fakeDb([{ id: "a", titleZh: "Nekomoe kissaten" }]);
    let searches = 0;
    const counting: SeriesSearchFn = async () => {
      searches += 1;
      return { results: [] };
    };

    await bindUnboundSeries({ db, series: db.rows, search: counting, delayMs: 0 });
    await bindUnboundSeries({ db, series: db.rows, search: counting, delayMs: 0 });
    await bindUnboundSeries({ db, series: db.rows, search: counting, delayMs: 0 });

    expect(searches).toBe(1);
  });

  test("★ a failed request does NOT latch — it is not an answer about the title", async () => {
    const db = fakeDb([{ id: "a", titleZh: "间谍过家家" }]);
    let calls = 0;
    const flaky: SeriesSearchFn = async (kw) => {
      calls += 1;
      if (calls === 1) throw new Error("network down");
      return matchingSearch(() => 111)(kw);
    };

    const first = await bindUnboundSeries({
      db,
      series: db.rows,
      search: flaky,
      delayMs: 0,
    });
    expect(first.bound).toBe(0);

    const second = await bindUnboundSeries({
      db,
      series: db.rows,
      search: flaky,
      delayMs: 0,
    });
    expect(second.bound).toBe(1);
    expect(db.rows[0].anilistId).toBe(111);
  });

  test("reports how much is left when the cap bites", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: `s${i}`,
      titleZh: `t${i}`,
    }));
    const db = fakeDb(rows);
    const summary = await bindUnboundSeries({
      db,
      series: db.rows,
      search: matchingSearch(() => 999),
      cap: 2,
      delayMs: 0,
    });

    expect(summary.attempted).toBe(2);
    expect(summary.bound).toBe(2);
    expect(summary.candidates).toBe(5);
    expect(summary.remaining).toBe(3);
  });

  test("stops between iterations when the caller aborts", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: `s${i}`,
      titleZh: `t${i}`,
    }));
    const db = fakeDb(rows);
    const controller = new AbortController();
    let searches = 0;
    const abortingSearch: SeriesSearchFn = async (kw) => {
      searches += 1;
      if (searches === 2) controller.abort();
      return matchingSearch(() => 999)(kw);
    };

    const summary = await bindUnboundSeries({
      db,
      series: db.rows,
      search: abortingSearch,
      signal: controller.signal,
      delayMs: 0,
    });

    expect(summary.attempted).toBe(2);
    expect(searches).toBe(2);
  });

  test("never throws when the whole search layer is broken", async () => {
    const db = fakeDb([{ id: "a", titleZh: "x" }, { id: "b", titleZh: "y" }]);
    const summary = await bindUnboundSeries({
      db,
      series: db.rows,
      search: failingSearch,
      delayMs: 0,
    });
    expect(summary.bound).toBe(0);
    expect(summary.attempted).toBe(2);
  });

  test("no candidates is a clean no-op, not an error", async () => {
    const db = fakeDb([{ id: "a", titleZh: "x", anilistId: 7 }]);
    const summary = await bindUnboundSeries({
      db,
      series: db.rows,
      search: emptySearch,
      delayMs: 0,
    });
    expect(summary).toMatchObject({ attempted: 0, bound: 0, changed: false });
    expect(db.writes).toHaveLength(0);
  });

  test("writes one ops-log row per binding, and none for a miss", async () => {
    const db = fakeDb([
      { id: "a", titleZh: "间谍过家家" },
      { id: "b", titleZh: "Nekomoe kissaten" },
    ]);
    const ops = fakeOpsLog();
    await bindUnboundSeries({
      db,
      series: db.rows,
      opsLog: ops,
      search: async (kw) =>
        kw === "间谍过家家"
          ? matchingSearch(() => 111)(kw)
          : { results: [] },
      delayMs: 0,
    });

    expect(ops.entries).toHaveLength(1);
    expect(ops.entries[0]).toMatchObject({ seriesId: "a", kind: "rematch" });
    expect((ops.entries[0].payload as Record<string, unknown>).anilistId).toBe(111);
  });

  test("★ the summary uses the key the drawer actually reads", async () => {
    // `OpsLogDrawer.summaryLineFor` reads `summary.targetTitle` for a rematch
    // row and falls back to the unnamed copy without it. A row keyed `title`
    // is not a type error, is not a test failure anywhere else, and renders
    // every automatic binding as a bare "重新匹配" — which is exactly the kind
    // of silent mismatch a schema-free `Record<string, unknown>` invites.
    const db = fakeDb([{ id: "a", titleZh: "间谍过家家" }]);
    const ops = fakeOpsLog();
    await bindUnboundSeries({
      db,
      series: db.rows,
      opsLog: ops,
      search: matchingSearch(() => 111),
      delayMs: 0,
    });

    const summary = ops.entries[0].summary as Record<string, unknown>;
    expect(summary.targetTitle).toBe("间谍过家家");
  });

  test("a broken ops log does not cost the binding that already landed", async () => {
    const db = fakeDb([{ id: "a", titleZh: "间谍过家家" }]);
    const summary = await bindUnboundSeries({
      db,
      series: db.rows,
      opsLog: {
        append: async () => {
          throw new Error("opsLog table missing");
        },
      },
      search: matchingSearch(() => 111),
      delayMs: 0,
    });

    expect(summary.bound).toBe(1);
    expect(db.rows[0].anilistId).toBe(111);
  });

  test("a database with no series table is a no-op rather than a crash", async () => {
    const summary = await bindUnboundSeries({
      // @ts-expect-error — deliberately malformed, mirrors a v4-shaped handle
      db: {},
      series: [{ id: "a", titleZh: "x" }],
      delayMs: 0,
    });
    expect(summary.attempted).toBe(0);
  });
});

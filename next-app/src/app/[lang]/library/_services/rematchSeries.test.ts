import { describe, expect, test } from "bun:test";
import type Dexie from "dexie";

import { rematchSeries } from "./rematchSeries";

// What these tests are for: a manual rematch is the most consequential thing a
// user can do to a library card — it re-points the card at a different anime in
// TWO disjoint id spaces — and until now it left no trace at all. `'rematch'`
// has been in `opsLogRepo`'s kind allowlist since v4, but the only writers were
// merge and split, so the series detail page's history had a hole exactly where
// the deliberate human decision goes.
//
// So the cases below defend three things: that the row happens, that it records
// enough to answer "why is this card pointing here" months later, and that
// failing to write it never costs the user the rematch that already landed.

// ─── fakes ──────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Ids the test can predict, so an assertion can name them. */
function counterUlid(): () => string {
  let n = 0;
  return () => `ulid-${++n}`;
}

interface FakeSeriesRow {
  id: string;
  anilistId?: number | null;
  [key: string]: unknown;
}

interface FakeSeasonRow {
  id: string;
  seriesId: string;
  number: number;
  animeId: number;
  [key: string]: unknown;
}

interface FakeDbInit {
  series?: FakeSeriesRow[];
  seasons?: FakeSeasonRow[];
  overrides?: Record<string, Record<string, unknown>>;
  /** `false` models a handle from before v4, which has no `opsLog` store. */
  withOpsLog?: boolean;
  /** The table is there but rejects writes — quota, corrupt store, upgrade. */
  opsLogThrows?: boolean;
  /** Fail the `writeBinding` half only, to pin the ordering of the log write. */
  failAnilistWrite?: boolean;
}

/**
 * Dexie-shaped double: only the surface `rematchSeries` and `writeBinding`
 * actually touch. bun test has no IndexedDB, and the point of these services
 * taking structural handles is that it does not need one.
 */
function fakeDb(init: FakeDbInit = {}) {
  const series = [...(init.series ?? [])];
  const seasons = [...(init.seasons ?? [])];
  const overrides = new Map(Object.entries(init.overrides ?? {}));
  const opsRows: Record<string, unknown>[] = [];

  const raw = {
    series: {
      get: async (id: string) => series.find((r) => r.id === id),
      update: async (id: string, changes: Record<string, unknown>) => {
        if (init.failAnilistWrite && changes.anilistId !== undefined) {
          throw new Error("series.update: simulated failure");
        }
        const i = series.findIndex((r) => r.id === id);
        if (i >= 0) series[i] = { ...series[i], ...changes };
        return 1;
      },
    },
    seasons: {
      where: (field: string) => ({
        equals: (value: unknown) => ({
          toArray: async () => seasons.filter((r) => r[field] === value),
        }),
      }),
      add: async (row: FakeSeasonRow) => {
        seasons.push(row);
        return row.id;
      },
      update: async (id: string, changes: Record<string, unknown>) => {
        const i = seasons.findIndex((r) => r.id === id);
        if (i >= 0) seasons[i] = { ...seasons[i], ...changes };
        return 1;
      },
    },
    userOverride: {
      get: async (id: string) => overrides.get(id),
      put: async (row: Record<string, unknown>) => {
        overrides.set(String(row.seriesId), row);
        return 1;
      },
    },
    // Dexie hands the scope its tables and runs the body; the double only has
    // to run the body. Note `opsLog` is deliberately NOT one of the tables the
    // service opens the scope over — the audit row is written after it commits.
    transaction: async (
      _mode: string,
      _a: unknown,
      _b: unknown,
      _c: unknown,
      body: () => Promise<unknown>,
    ) => body(),
    ...(init.withOpsLog === false
      ? {}
      : {
          opsLog: {
            put: async (row: Record<string, unknown>) => {
              if (init.opsLogThrows) throw new Error("QuotaExceededError");
              opsRows.push(row);
              return row.id;
            },
          },
        }),
  };

  return {
    /** Cast once, here: the service takes a real `Dexie` and this is not one. */
    handle: raw as unknown as Dexie,
    series,
    seasons,
    overrides,
    opsRows,
  };
}

interface RecordedEntry {
  seriesId: string;
  kind: string;
  payload?: Record<string, unknown>;
  summary?: Record<string, unknown>;
}

/** Injected in place of the repo, so an assertion can read the entry directly. */
function fakeOpsLog(opts: { throws?: boolean } = {}) {
  const entries: RecordedEntry[] = [];
  return {
    entries,
    append: async (entry: RecordedEntry) => {
      if (opts.throws) throw new Error("opsLog table missing");
      entries.push(entry);
      return entry;
    },
  };
}

/** A library card already pointing somewhere: AniList 100, dandanplay 900. */
function boundLibrary(overrides: Record<string, Record<string, unknown>> = {}) {
  return fakeDb({
    series: [{ id: "s1", anilistId: 100, titleZh: "旧标题" }],
    seasons: [{ id: "sea1", seriesId: "s1", number: 1, animeId: 900 }],
    overrides,
  });
}

// ─── the row ────────────────────────────────────────────────────────────────

describe("rematchSeries — ops log", () => {
  test("writes exactly one row, and it names both id spaces", async () => {
    const db = boundLibrary();
    const ops = fakeOpsLog();

    await rematchSeries({
      db: db.handle,
      seriesId: "s1",
      dandanAnimeId: 901,
      anilistId: 101,
      titleZh: "葬送的芙莉莲",
      opsLog: ops,
      ulid: counterUlid(),
      now: () => NOW,
    });

    expect(ops.entries).toHaveLength(1);
    expect(ops.entries[0]).toMatchObject({ seriesId: "s1", kind: "rematch" });
    // FROM must be the id the card carried before this pick, not the one it
    // carries after. Both are read inside the same transaction that overwrites
    // them, so reading a beat too late would silently record `from === to` and
    // the row would answer nothing.
    expect(ops.entries[0].payload).toMatchObject({
      dandanplay: { from: 900, to: 901 },
      anilist: { from: 100, to: 101, result: "written" },
    });
  });

  test("★ records that a human chose this — the sweep writes the same kind", async () => {
    // `bindUnboundSeries` logs its automatic bindings as `kind: 'rematch'` too,
    // with `source: 'auto-sweep'`. Without something separating them, a row
    // saying "this card points at 101" gives no way to tell whether a person
    // decided that or a background sweep guessed it, and only one of those is
    // evidence of what the user wanted.
    const db = boundLibrary();
    const ops = fakeOpsLog();

    await rematchSeries({
      db: db.handle,
      seriesId: "s1",
      anilistId: 101,
      opsLog: ops,
      ulid: counterUlid(),
      now: () => NOW,
    });

    const payload = ops.entries[0].payload as Record<string, unknown>;
    expect(payload.source).toBe("manual-pick");
    expect(payload.source).not.toBe("auto-sweep");
  });

  test("an AniList-only pick marks the dandanplay space untouched, not empty", async () => {
    // The card keeps its season id, and the row must not imply otherwise. A
    // `{ from: null }` here would read as "there was no dandanplay id", when
    // the truth is "this pick carried none, so we never looked" — and the
    // season below still holds 900 to prove the difference is real.
    const db = boundLibrary();
    const ops = fakeOpsLog();

    await rematchSeries({
      db: db.handle,
      seriesId: "s1",
      anilistId: 101,
      opsLog: ops,
      ulid: counterUlid(),
      now: () => NOW,
    });

    expect(ops.entries[0].payload).toMatchObject({
      dandanplay: null,
      anilist: { from: 100, to: 101 },
    });
    expect(db.seasons[0].animeId).toBe(900);
  });

  test("a dandanplay-only pick marks the AniList space untouched", async () => {
    const db = boundLibrary();
    const ops = fakeOpsLog();

    await rematchSeries({
      db: db.handle,
      seriesId: "s1",
      dandanAnimeId: 901,
      opsLog: ops,
      ulid: counterUlid(),
      now: () => NOW,
    });

    expect(ops.entries[0].payload).toMatchObject({
      dandanplay: { from: 900, to: 901 },
      anilist: null,
    });
    expect(db.series[0].anilistId).toBe(100);
  });

  test("a series with no season yet records that it had no dandanplay id", async () => {
    const db = fakeDb({ series: [{ id: "s1" }] });
    const ops = fakeOpsLog();

    await rematchSeries({
      db: db.handle,
      seriesId: "s1",
      dandanAnimeId: 901,
      opsLog: ops,
      ulid: counterUlid(),
      now: () => NOW,
    });

    expect(ops.entries[0].payload).toMatchObject({
      dandanplay: { from: null, to: 901 },
    });
    expect(db.seasons[0]).toMatchObject({ animeId: 901, number: 1 });
  });

  test("★ records that a re-pick of the same id did not move the binding", async () => {
    // Re-picking what is already bound is a real thing users do, and `to`
    // alone cannot describe it: `writeBinding` answers `unchanged`, nothing
    // moves, and the row would otherwise look identical to a real re-point.
    const db = boundLibrary({ s1: { seriesId: "s1", locked: true } });
    const ops = fakeOpsLog();

    await rematchSeries({
      db: db.handle,
      seriesId: "s1",
      anilistId: 100,
      opsLog: ops,
      ulid: counterUlid(),
      now: () => NOW,
    });

    expect(ops.entries).toHaveLength(1);
    expect(ops.entries[0].payload).toMatchObject({
      anilist: { from: 100, to: 100, result: "unchanged" },
    });
  });

  test("summary is structured data, not a rendered sentence", async () => {
    // `OpsLog.summary` is what the drawer renders FROM, so the human copy has
    // to stay in the dictionary. `targetTitle` is the exact key
    // `OpsLogDrawer.summaryLineFor` reads for a rematch row; drop it and the
    // drawer falls back from "重新匹配为 X" to a bare "重新匹配".
    const db = boundLibrary();
    const ops = fakeOpsLog();

    await rematchSeries({
      db: db.handle,
      seriesId: "s1",
      dandanAnimeId: 901,
      anilistId: 101,
      titleZh: "葬送的芙莉莲",
      opsLog: ops,
      ulid: counterUlid(),
      now: () => NOW,
    });

    expect(ops.entries[0].summary).toEqual({
      targetTitle: "葬送的芙莉莲",
      anilistId: 101,
      dandanAnimeId: 901,
    });
  });

  test("summary reports the binding still in effect when the pick set no AniList id", async () => {
    const db = boundLibrary();
    const ops = fakeOpsLog();

    await rematchSeries({
      db: db.handle,
      seriesId: "s1",
      dandanAnimeId: 901,
      titleEn: "Frieren",
      opsLog: ops,
      ulid: counterUlid(),
      now: () => NOW,
    });

    // 100 is what the card points at, and it is a real read rather than a
    // guess: the series row is fetched on every rematch.
    expect(ops.entries[0].summary).toEqual({
      targetTitle: "Frieren",
      anilistId: 100,
      dandanAnimeId: 901,
    });
  });

  // ─── the log must never be the thing that fails ───────────────────────────

  test("★ a broken ops log does not cost the user the rematch that landed", async () => {
    const db = boundLibrary();

    await rematchSeries({
      db: db.handle,
      seriesId: "s1",
      dandanAnimeId: 901,
      anilistId: 101,
      opsLog: fakeOpsLog({ throws: true }),
      ulid: counterUlid(),
      now: () => NOW,
    });

    expect(db.seasons[0].animeId).toBe(901);
    expect(db.series[0].anilistId).toBe(101);
    expect(db.overrides.get("s1")).toMatchObject({ locked: true });
  });

  test("an opsLog table that rejects the write is swallowed the same way", async () => {
    // Same guarantee one layer down: here the throw comes out of the repo the
    // service built for itself, not out of an injected double.
    const db = fakeDb({
      series: [{ id: "s1", anilistId: 100 }],
      seasons: [{ id: "sea1", seriesId: "s1", number: 1, animeId: 900 }],
      opsLogThrows: true,
    });

    await rematchSeries({
      db: db.handle,
      seriesId: "s1",
      dandanAnimeId: 901,
      ulid: counterUlid(),
      now: () => NOW,
    });

    expect(db.opsRows).toHaveLength(0);
    expect(db.seasons[0].animeId).toBe(901);
  });

  test("a handle with no opsLog store at all is not a failure", async () => {
    const db = fakeDb({
      series: [{ id: "s1", anilistId: 100 }],
      seasons: [{ id: "sea1", seriesId: "s1", number: 1, animeId: 900 }],
      withOpsLog: false,
    });

    await rematchSeries({
      db: db.handle,
      seriesId: "s1",
      dandanAnimeId: 901,
      anilistId: 101,
      ulid: counterUlid(),
      now: () => NOW,
    });

    expect(db.seasons[0].animeId).toBe(901);
    expect(db.series[0].anilistId).toBe(101);
  });

  // ─── the default path, which is the one production takes ──────────────────

  test("★ builds its own repo when no log is injected — both call sites pass none", async () => {
    // `LibraryShell` and `LocalSeriesShell` hand this service a bare `db`. If
    // the log only existed when injected, the hole this whole change closes
    // would still be open in production. Going through `makeOpsLogRepo` is
    // also what stamps `id` / `ts` / `undoableUntil` the same way merge and
    // split rows are stamped — and what proves the repo's kind allowlist
    // accepts `'rematch'`, which nothing had ever exercised.
    const db = boundLibrary();

    await rematchSeries({
      db: db.handle,
      seriesId: "s1",
      dandanAnimeId: 901,
      anilistId: 101,
      titleZh: "葬送的芙莉莲",
      ulid: counterUlid(),
      now: () => NOW,
    });

    expect(db.opsRows).toHaveLength(1);
    expect(db.opsRows[0]).toMatchObject({
      seriesId: "s1",
      kind: "rematch",
      ts: NOW,
      undoableUntil: NOW + DAY_MS,
      undone: false,
    });
    // Stamped from the caller's factory, not the repo's `op_…` fallback:
    // `OpsLog.id` is documented as a ulid.
    expect(String(db.opsRows[0].id)).toStartWith("ulid-");
  });

  // ─── ordering ─────────────────────────────────────────────────────────────

  test("logs nothing when the rematch itself never happened", async () => {
    const db = fakeDb({ series: [] });
    const ops = fakeOpsLog();

    await expect(
      rematchSeries({
        db: db.handle,
        seriesId: "ghost",
        anilistId: 101,
        opsLog: ops,
        ulid: counterUlid(),
        now: () => NOW,
      }),
    ).rejects.toThrow("does not exist");

    expect(ops.entries).toHaveLength(0);
  });

  test("logs nothing when the binding half fails, because the row would be a claim", async () => {
    // The row says a rematch happened. `writeBinding` throwing means half of
    // one did — the caller surfaces that, and the retry (idempotent) is what
    // logs. Recording it here instead would put an "anilist: 100 → 101" line
    // in the history of a card still pointing at 100.
    const db = fakeDb({
      series: [{ id: "s1", anilistId: 100 }],
      seasons: [{ id: "sea1", seriesId: "s1", number: 1, animeId: 900 }],
      failAnilistWrite: true,
    });
    const ops = fakeOpsLog();

    await expect(
      rematchSeries({
        db: db.handle,
        seriesId: "s1",
        dandanAnimeId: 901,
        anilistId: 101,
        opsLog: ops,
        ulid: counterUlid(),
        now: () => NOW,
      }),
    ).rejects.toThrow("simulated failure");

    expect(ops.entries).toHaveLength(0);
    // The season half stands, exactly as the service's own comment says.
    expect(db.seasons[0].animeId).toBe(901);
  });
});

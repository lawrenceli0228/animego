import { beforeEach, describe, expect, test } from "bun:test";

import {
  applyFailure,
  classifyPushFailure,
  decidePush,
  findRootSeriesId,
  getSyncFailure,
  judgeSyncMemory,
  listSyncFailures,
  MAX_PUSH_ATTEMPTS,
  onSyncFailure,
  parseServerSubscriptions,
  readSyncedEpisodes,
  reconcileLibrary,
  reconcileSeries,
  REPORT_AT_ATTEMPT,
  resetWatchSyncState,
  resolveGroupSeriesIds,
  startTracking,
  type PushResponse,
  type ServerSubscription,
  type SubscriptionSyncApi,
  type SyncFailure,
  type TrackingDb,
  type WatchSyncEpisode,
  type WatchSyncOverride,
  type WatchSyncProgress,
  type WatchSyncSeries,
} from "./watchSync";

// ─── fakes ──────────────────────────────────────────────────────────────────

interface FakeCall {
  kind: "mark" | "create";
  anilistId: number;
  /** The DELTA the pass offered, ascending — never the library's whole set. */
  episodes?: number[];
}

interface FakeApi extends SubscriptionSyncApi {
  /** Writes only. The account-wide read has its own counter so that every
   *  existing `expect(api.calls).toEqual([…])` keeps meaning what it meant. */
  calls: FakeCall[];
  listCalls: number;
}

function fakeApi(
  responses: Partial<{
    mark: PushResponse | PushResponse[];
    create: PushResponse;
    signedIn: boolean;
    /**
     * The account snapshot. DEFAULT IS `null` — "could not read" — so a test
     * that says nothing about subscriptions gets no revalidation and exercises
     * exactly the behaviour it was written for.
     */
    subscriptions: ServerSubscription[] | null;
  }> = {},
): FakeApi {
  const calls: FakeCall[] = [];
  const markQueue = Array.isArray(responses.mark)
    ? [...responses.mark]
    : responses.mark
      ? [responses.mark]
      : [];
  const api: FakeApi = {
    calls,
    listCalls: 0,
    isSignedIn: () => responses.signedIn ?? true,
    async markEpisodes(anilistId, episodes) {
      calls.push({ kind: "mark", anilistId, episodes: [...episodes] });
      return markQueue.length > 1
        ? (markQueue.shift() as PushResponse)
        : (markQueue[0] ?? { ok: true, status: 200 });
    },
    async createIfAbsent(anilistId) {
      calls.push({ kind: "create", anilistId });
      return responses.create ?? { ok: true, status: 201 };
    },
    async listSubscriptions() {
      api.listCalls += 1;
      return responses.subscriptions ?? null;
    },
  };
  return api;
}

/** A subscription row as the server would report it. */
const serverSub = (
  anilistId: number,
  currentEpisode: number,
  subscribedAt: number | null,
): ServerSubscription => ({ anilistId, currentEpisode, subscribedAt });

interface FakeDbState {
  series: WatchSyncSeries[];
  episodes: WatchSyncEpisode[];
  progress: WatchSyncProgress[];
  overrides?: WatchSyncOverride[] | null;
}

function fakeDb(state: FakeDbState): TrackingDb & { updates: Record<string, unknown>[] } {
  const updates: Record<string, unknown>[] = [];
  const locks = new Map<string, { locked?: boolean }>();
  const table = <T extends { seriesId?: string }>(rows: readonly T[]) => ({
    where: () => ({
      anyOf: (ids: readonly string[]) => ({
        toArray: async () => rows.filter((r) => ids.includes(r.seriesId ?? "")),
      }),
    }),
  });
  return {
    updates,
    series: {
      get: async (id: string) => state.series.find((s) => s.id === id),
      update: async (id: string, changes: Record<string, unknown>) => {
        updates.push({ id, ...changes });
        const row = state.series.find((s) => s.id === id);
        if (row) Object.assign(row, changes);
        return 1;
      },
    },
    episodes: table(state.episodes),
    progress: table(state.progress),
    userOverride:
      state.overrides === null
        ? null
        : {
            toArray: async () => state.overrides ?? [],
            // Present because the real Dexie table has them and `readBinding`
            // calls `get`. A fake that stops at `toArray` compiles and then
            // throws at runtime — see TrackingDb's doc comment.
            get: async (id: string) => locks.get(id),
            put: async (row: Record<string, unknown>) => {
              locks.set(String(row.seriesId), row as { locked?: boolean });
              return 1;
            },
          },
  };
}

const main = (id: string, seriesId: string, number: number): WatchSyncEpisode => ({
  id,
  seriesId,
  number,
  kind: "main",
});

const done = (episodeId: string, seriesId: string): WatchSyncProgress => ({
  episodeId,
  seriesId,
  completed: true,
});

beforeEach(() => {
  resetWatchSyncState();
});

// ─── merge graph ────────────────────────────────────────────────────────────

describe("findRootSeriesId", () => {
  const overrides: WatchSyncOverride[] = [
    { seriesId: "B", mergedFrom: ["A"] },
    { seriesId: "C", mergedFrom: ["B"] },
  ];

  test("returns the series itself when nothing was merged", () => {
    expect(findRootSeriesId([], "A")).toBe("A");
  });

  test("walks a two-level merge chain up to the card that renders it", () => {
    // A was merged into B, then B into C. The card is C.
    expect(findRootSeriesId(overrides, "A")).toBe("C");
  });

  test("a root resolves to itself", () => {
    expect(findRootSeriesId(overrides, "C")).toBe("C");
  });

  test("survives a cyclic override table instead of hanging", () => {
    const cyclic: WatchSyncOverride[] = [
      { seriesId: "X", mergedFrom: ["Y"] },
      { seriesId: "Y", mergedFrom: ["X"] },
    ];
    expect(["X", "Y"]).toContain(findRootSeriesId(cyclic, "X"));
  });

  test("resolveGroupSeriesIds walks the same graph downward, root first", () => {
    expect(resolveGroupSeriesIds(overrides, "C")).toEqual(["C", "B", "A"]);
  });
});

// ─── push policy ────────────────────────────────────────────────────────────

describe("decidePush", () => {
  const base = {
    isRoot: true,
    anilistId: 154587,
    synced: new Set([1, 2, 3]),
    watched: [1, 2, 3, 4, 5],
    attempts: 0,
  };

  test("pushes exactly the episodes this device has not pushed yet", () => {
    expect(decidePush(base)).toEqual({
      push: true,
      anilistId: 154587,
      episodes: [4, 5],
    });
  });

  test("A GAP BELOW THE MAXIMUM IS PUSHED — this is the whole bug", () => {
    // The reported state: the library knows five episodes, the memory knows
    // only the top one. A high-water comparison sees 9 <= 9 and stops; the
    // difference sees four episodes the server has never been told about.
    expect(
      decidePush({ ...base, synced: new Set([9]), watched: [3, 5, 7, 8, 9] }),
    ).toEqual({ push: true, anilistId: 154587, episodes: [3, 5, 7, 8] });
  });

  test("offers the delta in ascending order, whatever order the library kept", () => {
    // resolveWatchedEpisodes sorts, and decidePush filters in place, so the
    // request body is sorted by construction rather than by luck.
    const plan = decidePush({ ...base, synced: new Set<number>(), watched: [1, 2, 3, 4, 5] });
    expect(plan).toMatchObject({ episodes: [1, 2, 3, 4, 5] });
  });

  test("refuses a merged-in source even when it carries its own binding", () => {
    // The whole point: a source keeps the anilistId it had as its own card.
    // Pushing it writes progress onto a different show, permanently, because
    // the server's GREATEST guard never walks a value back down.
    expect(decidePush({ ...base, isRoot: false })).toEqual({
      push: false,
      reason: "not-root",
    });
  });

  test("checks root-ness before the binding, so an unbound source is still not-root", () => {
    expect(decidePush({ ...base, isRoot: false, anilistId: null }).push).toBe(false);
    expect(decidePush({ ...base, isRoot: false, anilistId: null })).toEqual({
      push: false,
      reason: "not-root",
    });
  });

  test("does not push an unbound series", () => {
    for (const anilistId of [null, undefined, 0, -1, 1.5, "x"]) {
      expect(decidePush({ ...base, anilistId })).toEqual({
        push: false,
        reason: "unbound",
      });
    }
  });

  test("does not push when nothing main has been completed", () => {
    expect(decidePush({ ...base, watched: [] })).toEqual({
      push: false,
      reason: "nothing-watched",
    });
  });

  test("does not push when the memory already covers every local episode", () => {
    expect(decidePush({ ...base, synced: new Set([1, 2, 3, 4, 5]) })).toEqual({
      push: false,
      reason: "already-synced",
    });
    // A memory AHEAD of the library is still nothing to send. Local episodes
    // can disappear (a rescan, a split); the marks they produced did not.
    expect(decidePush({ ...base, synced: new Set([1, 2, 3, 4, 5, 6, 7]) }).push).toBe(false);
  });

  test("treats a never-synced series as having pushed nothing", () => {
    expect(decidePush({ ...base, synced: new Set<number>() })).toEqual({
      push: true,
      anilistId: 154587,
      episodes: [1, 2, 3, 4, 5],
    });
  });

  test("stops pushing once the attempt ceiling is reached (CG2)", () => {
    expect(decidePush({ ...base, attempts: MAX_PUSH_ATTEMPTS })).toEqual({
      push: false,
      reason: "blocked",
    });
  });

  test("applies no upper bound — that guard lives on the server (decision 4)", () => {
    // And an out-of-range episode is OFFERED rather than filtered out: it is
    // evidence of a bad binding, and the server's 400 is how that becomes
    // visible instead of a series that looks healthy and never syncs.
    expect(
      decidePush({ ...base, synced: new Set<number>(), watched: [9999] }),
    ).toMatchObject({ push: true, episodes: [9999] });
  });
});

// ─── the memory, and what an upgrading reader's row means ───────────────────

describe("readSyncedEpisodes", () => {
  test("reads a stored set as itself", () => {
    expect([...readSyncedEpisodes({ lastSyncedEpisodes: [3, 5, 9] })]).toEqual([3, 5, 9]);
  });

  test("A LEGACY MAXIMUM MEANS 1..N — what migration 0024 actually wrote", () => {
    // The old build pushed one number, `current_episode = N`; migration 0024
    // then backfilled episode_watches rows 1..N for exactly those rows. The
    // memory is a claim about the server's state, so this is not a guess.
    expect([...readSyncedEpisodes({ lastSyncedEpisode: 4 })]).toEqual([1, 2, 3, 4]);
  });

  test("an upgrading reader is not re-pushed, because the delta is empty", () => {
    const upgrading = { lastSyncedEpisode: 5, lastSyncedSubscribedAt: T1 };
    expect(
      decidePush({
        isRoot: true,
        anilistId: 154587,
        synced: readSyncedEpisodes(upgrading),
        watched: [1, 2, 3, 4, 5],
        attempts: 0,
      }),
    ).toEqual({ push: false, reason: "already-synced" });
  });

  test("a stored EMPTY set is a fact, not a missing field", () => {
    // revalidateSyncMemory clears the memory by writing [] alongside 0. If an
    // empty array fell through to the number beside it the clear would undo
    // itself on the next read — and on a row whose number had not yet been
    // rewritten, it would undo itself into the old high-water mark.
    expect(readSyncedEpisodes({ lastSyncedEpisodes: [], lastSyncedEpisode: 5 }).size).toBe(0);
  });

  test("never synced at all is an empty memory, not episode zero", () => {
    for (const row of [undefined, null, {}, { lastSyncedEpisode: 0 }, { lastSyncedEpisode: null }]) {
      expect(readSyncedEpisodes(row).size).toBe(0);
    }
  });

  test("drops junk members rather than the whole memory", () => {
    // A stored set is user-writable state that survives across versions, and
    // one bad member must not read as "this device has pushed nothing" — that
    // reading re-pushes the library and resurrects unmarks.
    const junk = [3, "5" as unknown as number, null as unknown as number, 1.5, -2, 0, 9];
    expect([...readSyncedEpisodes({ lastSyncedEpisodes: junk })]).toEqual([3, 9]);
  });
});

// ─── subscription identity ──────────────────────────────────────────────────

/** `subscriptions.created_at` of the row the memory was written against… */
const T1 = 1_700_000_000_000;
/** …and of the row that replaced it after an unsubscribe/re-subscribe. */
const T2 = 1_700_000_600_000;

describe("parseServerSubscriptions", () => {
  test("reads the envelope and converts created_at to epoch ms", () => {
    // Arrange — the shape go-api actually emits: `{data:[…]}`, RFC 3339.
    const body = {
      data: [
        { anilistId: 154587, currentEpisode: 5, subscribedAt: "2026-08-22T05:18:03.302508Z" },
      ],
    };

    // Act
    const rows = parseServerSubscriptions(body);

    // Assert
    expect(rows).toEqual([
      {
        anilistId: 154587,
        currentEpisode: 5,
        subscribedAt: Date.parse("2026-08-22T05:18:03.302508Z"),
      },
    ]);
  });

  test("survives a bare array, a null envelope and a junk row", () => {
    expect(parseServerSubscriptions([{ anilistId: 7, currentEpisode: 2, subscribedAt: T1 }])).toEqual(
      [{ anilistId: 7, currentEpisode: 2, subscribedAt: T1 }],
    );
    expect(parseServerSubscriptions(null)).toEqual([]);
    expect(parseServerSubscriptions({ data: null })).toEqual([]);
    expect(parseServerSubscriptions({ data: [null, 3, "x"] })).toEqual([]);
  });

  test("drops a row with no usable anilistId rather than the whole snapshot", () => {
    const rows = parseServerSubscriptions({
      data: [
        { anilistId: "nope", currentEpisode: 1, subscribedAt: T1 },
        { anilistId: 11, currentEpisode: 1, subscribedAt: T1 },
      ],
    });
    expect(rows.map((r) => r.anilistId)).toEqual([11]);
  });

  test("keeps a row whose subscribedAt is unusable, with a null identity", () => {
    // It still tells us the progress; it just cannot prove anything about the
    // row's lifetime, and judgeSyncMemory below is what acts on that.
    expect(parseServerSubscriptions({ data: [{ anilistId: 11, currentEpisode: 3 }] })).toEqual([
      { anilistId: 11, currentEpisode: 3, subscribedAt: null },
    ]);
  });

  test("a missing currentEpisode reads as zero, not as NaN", () => {
    expect(parseServerSubscriptions({ data: [{ anilistId: 11, subscribedAt: T1 }] })).toEqual([
      { anilistId: 11, currentEpisode: 0, subscribedAt: T1 },
    ]);
  });
});

describe("judgeSyncMemory", () => {
  const base = {
    lastSyncedEpisode: 5,
    lastSyncedSubscribedAt: T1,
    server: serverSub(154587, 5, T1),
  };

  test("the steady state: same row, nothing to do", () => {
    expect(judgeSyncMemory(base)).toBe("intact");
  });

  test("a replaced row holding less than we recorded is the bug", () => {
    // Unsubscribe cascaded every episode_watches row away (migration 0024);
    // re-subscribing inserted a NEW row, so created_at moved and progress is 0.
    expect(judgeSyncMemory({ ...base, server: serverSub(154587, 0, T2) })).toBe("replaced");
  });

  test("AN INTENTIONAL UNMARK IS NOT A REPLACEMENT — created_at did not move", () => {
    // This is the case a "server is lower, so push" rule gets wrong, and it is
    // the likeliest unmark there is: the reader unchecked the top episode, so
    // current_episode fell from 5 to 4 while the row stayed the same row.
    expect(judgeSyncMemory({ ...base, server: serverSub(154587, 4, T1) })).toBe("intact");
    // …and the same holds all the way down to an emptied set.
    expect(judgeSyncMemory({ ...base, server: serverSub(154587, 0, T1) })).toBe("intact");
  });

  test("ONLY AN EMPTY unfamiliar row may be re-pushed — 'behind us' is not the test", () => {
    // A re-created row starts at exactly 0, so anything above that means
    // somebody already wrote to the NEW row. These two are indistinguishable:
    //   another device pushed 3 of our 5 and has not caught up yet
    //   the new row reached 5 and the reader unchecked back down to 3
    // Re-pushing 5 re-marks episode 5 in the second, so neither may push.
    for (const currentEpisode of [1, 3, 4]) {
      expect(judgeSyncMemory({ ...base, server: serverSub(154587, currentEpisode, T2) })).toBe(
        "unknown",
      );
    }
    expect(judgeSyncMemory({ ...base, server: serverSub(154587, 0, T2) })).toBe("replaced");
  });

  test("an unfamiliar row level with or ahead of us is nothing to heal", () => {
    expect(judgeSyncMemory({ ...base, server: serverSub(154587, 5, T2) })).toBe("unknown");
    expect(judgeSyncMemory({ ...base, server: serverSub(154587, 9, T2) })).toBe("unknown");
  });

  test("a never-synced memory has no claim to falsify", () => {
    for (const lastSyncedEpisode of [undefined, null, 0]) {
      expect(judgeSyncMemory({ ...base, lastSyncedEpisode })).toBe("intact");
    }
  });

  test("absent from the snapshot is unknown — the reader unsubscribed and stayed gone", () => {
    // Not "replaced". Clearing here would push, the push would 404, and the
    // 404 recovery would re-create the subscription they just deleted.
    expect(judgeSyncMemory({ ...base, server: null })).toBe("unknown");
    expect(judgeSyncMemory({ ...base, server: undefined })).toBe("unknown");
  });

  test("an unusable timestamp on either side is unknown, never a replacement", () => {
    expect(judgeSyncMemory({ ...base, server: serverSub(154587, 0, null) })).toBe("unknown");
    for (const recorded of [undefined, null, "", "not-a-date", Number.NaN]) {
      expect(
        judgeSyncMemory({
          ...base,
          lastSyncedSubscribedAt: recorded,
          server: serverSub(154587, 0, T2),
        }),
      ).toBe("unknown");
    }
  });

  test("accepts a recorded identity in either stored form", () => {
    const iso = "2026-08-22T05:18:03.302Z";
    expect(
      judgeSyncMemory({
        ...base,
        lastSyncedSubscribedAt: iso,
        server: serverSub(154587, 0, Date.parse(iso)),
      }),
    ).toBe("intact");
  });
});

// ─── failure classification (CG2) ───────────────────────────────────────────

describe("classifyPushFailure", () => {
  test("counts a 404 — the subscription or the cached title is missing", () => {
    expect(classifyPushFailure(404)).toBe("deterministic");
  });

  test("counts a 400 — Lane A's episode-exceeds-total is the same shape", () => {
    expect(classifyPushFailure(400)).toBe("deterministic");
  });

  test("does not count a network error", () => {
    expect(classifyPushFailure(null)).toBe("transient");
    expect(classifyPushFailure(undefined)).toBe("transient");
  });

  test("does not count 5xx", () => {
    for (const status of [500, 502, 503]) {
      expect(classifyPushFailure(status)).toBe("transient");
    }
  });

  test("does not count rate limiting, despite it being a 4xx", () => {
    for (const status of [408, 425, 429]) {
      expect(classifyPushFailure(status)).toBe("transient");
    }
  });

  test("treats 401 as its own case — the fix is a login, not a retry budget", () => {
    expect(classifyPushFailure(401)).toBe("auth");
  });
});

describe("applyFailure", () => {
  const args = {
    prev: null as SyncFailure | null,
    seriesId: "S",
    status: 404 as number | null,
    message: "Subscription not found",
    now: 1000,
  };

  test("accrues one attempt per deterministic failure and blocks at the ceiling", () => {
    let state = applyFailure({ ...args, kind: "deterministic" });
    expect(state).toMatchObject({ attempts: 1, blocked: false });

    state = applyFailure({ ...args, prev: state, kind: "deterministic" });
    expect(state).toMatchObject({ attempts: 2, blocked: false });

    state = applyFailure({ ...args, prev: state, kind: "deterministic" });
    expect(state).toMatchObject({ attempts: MAX_PUSH_ATTEMPTS, blocked: true });
  });

  test("REPORTS ON THE FIRST FAILURE, NOT THE THIRD — the whole of T7", () => {
    // The two thresholds are independent. `blocked` is still the third
    // attempt; `reportable` is the first, because that is the only one a
    // reader whose session is one episode long ever reaches.
    let state = applyFailure({ ...args, kind: "deterministic" });
    expect(state).toMatchObject({ attempts: REPORT_AT_ATTEMPT, reportable: true, blocked: false });

    state = applyFailure({ ...args, prev: state, kind: "deterministic" });
    expect(state).toMatchObject({ attempts: 2, reportable: false, blocked: false });

    state = applyFailure({ ...args, prev: state, kind: "deterministic" });
    expect(state).toMatchObject({ attempts: 3, reportable: false, blocked: true });
  });

  test("the two thresholds are ordered so the reporting one is reachable", () => {
    // A ceiling below the reporting attempt would mean the series stops being
    // pushed before anyone is told — CG2 silent again, by configuration.
    expect(REPORT_AT_ATTEMPT).toBeLessThanOrEqual(MAX_PUSH_ATTEMPTS);
    expect(REPORT_AT_ATTEMPT).toBeGreaterThan(0);
  });

  test("a run cleared by a success is reported again when it breaks anew", () => {
    // `clearFailure` drops the entry, so the next deterministic failure comes
    // in with `prev: null`. That is a NEW fault, not the old one repeating.
    const first = applyFailure({ ...args, kind: "deterministic" });
    expect(first?.reportable).toBe(true);

    const afterHealing = applyFailure({ ...args, prev: null, kind: "deterministic" });
    expect(afterHealing).toMatchObject({ attempts: 1, reportable: true });
  });

  test("leaves the budget untouched for transient failures", () => {
    const seeded = applyFailure({ ...args, kind: "deterministic" });
    const after = applyFailure({ ...args, prev: seeded, kind: "transient" });
    expect(after?.attempts).toBe(1);
    // And carries no fresh report: it is the previous entry, verbatim.
    expect(after).toBe(seeded);
  });

  test("a week offline never exhausts the budget and never raises a report", () => {
    let state: SyncFailure | null = null;
    for (let i = 0; i < 100; i += 1) {
      state = applyFailure({ ...args, prev: state, kind: "transient", status: null });
    }
    expect(state).toBeNull();
  });

  test("an expired session never exhausts the budget or reports either", () => {
    let state: SyncFailure | null = null;
    for (let i = 0; i < 10; i += 1) {
      state = applyFailure({ ...args, prev: state, kind: "auth", status: 401 });
    }
    expect(state).toBeNull();
  });
});

// ─── reconcileSeries ────────────────────────────────────────────────────────

describe("reconcileSeries", () => {
  function oneSeries(over: Partial<WatchSyncSeries> = {}) {
    return fakeDb({
      series: [{ id: "S1", anilistId: 154587, lastSyncedEpisode: 2, ...over }],
      episodes: [main("e1", "S1", 1), main("e2", "S1", 2), main("e3", "S1", 3)],
      progress: [done("e1", "S1"), done("e2", "S1"), done("e3", "S1")],
      overrides: [],
    });
  }

  test("pushes only what the server has not been told, and remembers all of it", async () => {
    // Arrange — the memory is a legacy maximum of 2, which reads as {1,2};
    // the library knows 1, 2 and 3.
    const db = oneSeries();
    const api = fakeApi();

    // Act
    const result = await reconcileSeries(db, "S1", { api });

    // Assert
    expect(result).toEqual({
      seriesId: "S1",
      outcome: "pushed",
      episodes: [3],
      episode: 3,
      anilistId: 154587,
    });
    expect(api.calls).toEqual([
      { kind: "mark", anilistId: 154587, episodes: [3] },
    ]);
    // The memory is the UNION of what it knew and what it just sent — not a
    // copy of the local set, so a rescan that loses episode 1 cannot make
    // this device offer episode 1 again.
    expect(db.updates).toEqual([
      { id: "S1", lastSyncedEpisodes: [1, 2, 3], lastSyncedEpisode: 3 },
    ]);
  });

  test("re-running immediately is a no-op — state is the truth, not a queue", async () => {
    const db = oneSeries();
    const api = fakeApi();
    await reconcileSeries(db, "S1", { api });
    const second = await reconcileSeries(db, "S1", { api });

    expect(second.outcome).toBe("already-synced");
    expect(api.calls).toHaveLength(1);
  });

  test("only main episodes count — an NCOP ticked off never moves the server", async () => {
    // Arrange — nothing but an opening credit-less version watched.
    const db = fakeDb({
      series: [{ id: "S1", anilistId: 154587 }],
      episodes: [{ id: "nc1", seriesId: "S1", number: 1, kind: "ncop" }],
      progress: [done("nc1", "S1")],
      overrides: [],
    });
    const api = fakeApi();

    // Act
    const result = await reconcileSeries(db, "S1", { api });

    // Assert — the local checkmark stands; the home page does not move.
    expect(result.outcome).toBe("nothing-watched");
    expect(api.calls).toEqual([]);
    expect(db.updates).toEqual([]);
  });

  test("an SP ticked off after episode 3 does not push the home page to 4", async () => {
    // Arrange — the specials are numbered from 1 by episodeParser just like the
    // main run, so an SP4 would look like "episode 4" to anything that did not
    // filter on kind.
    const db = fakeDb({
      series: [{ id: "S1", anilistId: 154587, lastSyncedEpisode: 3 }],
      episodes: [
        main("e3", "S1", 3),
        { id: "sp4", seriesId: "S1", number: 4, kind: "sp" },
      ],
      progress: [done("e3", "S1"), done("sp4", "S1")],
      overrides: [],
    });
    const api = fakeApi();

    // Act
    const result = await reconcileSeries(db, "S1", { api });

    // Assert — locally ticked, server untouched. This is the intended
    // behaviour, not a gap: AniList counts main episodes.
    expect(result.outcome).toBe("already-synced");
    expect(api.calls).toEqual([]);
  });

  test("a merged-in source pushes to the ROOT's binding, never its own", async () => {
    // Arrange — S2 was merged into S1 and still carries the id it had while
    // it was its own card. Progress lives on S2's episode rows.
    const db = fakeDb({
      series: [
        { id: "S1", anilistId: 111, lastSyncedEpisode: 0 },
        { id: "S2", anilistId: 999, lastSyncedEpisode: 0 },
      ],
      episodes: [main("e1", "S1", 1), main("e2", "S2", 2)],
      progress: [done("e1", "S1"), done("e2", "S2")],
      overrides: [{ seriesId: "S1", mergedFrom: ["S2"] }],
    });
    const api = fakeApi();

    // Act — reconcile via the SOURCE id, the way a completion write would.
    const result = await reconcileSeries(db, "S2", { api });

    // Assert — root id, root binding, group-wide high-water mark.
    expect(result).toEqual({
      seriesId: "S1",
      outcome: "pushed",
      episodes: [1, 2],
      episode: 2,
      anilistId: 111,
    });
    expect(api.calls).toEqual([{ kind: "mark", anilistId: 111, episodes: [1, 2] }]);
    expect(db.updates).toEqual([
      { id: "S1", lastSyncedEpisodes: [1, 2], lastSyncedEpisode: 2 },
    ]);
  });

  test("does not touch the network for an unbound series", async () => {
    const db = oneSeries({ anilistId: undefined });
    const api = fakeApi();
    const result = await reconcileSeries(db, "S1", { api });

    expect(result.outcome).toBe("unbound");
    expect(api.calls).toEqual([]);
  });

  test("resolves a missing binding on demand when the caller offers a resolver", async () => {
    // Arrange — trigger 3 (entering the player). The resume row and the
    // new-additions row jump straight here without passing through the card
    // click, so this is the only place those users pick up an id.
    const db = oneSeries({ anilistId: undefined, lastSyncedEpisode: undefined });
    const api = fakeApi();

    // Act
    const result = await reconcileSeries(db, "S1", {
      api,
      resolveBinding: async () => 154587,
    });

    // Assert
    expect(result).toEqual({
      seriesId: "S1",
      outcome: "pushed",
      episodes: [1, 2, 3],
      episode: 3,
      anilistId: 154587,
    });
    expect(api.calls).toEqual([{ kind: "mark", anilistId: 154587, episodes: [1, 2, 3] }]);
  });

  test("the resolver is not consulted when the series is already bound", async () => {
    const db = oneSeries();
    let called = 0;
    await reconcileSeries(db, "S1", {
      api: fakeApi(),
      resolveBinding: async () => {
        called += 1;
        return 1;
      },
    });
    expect(called).toBe(0);
  });

  test("skips the request entirely when nobody is signed in", async () => {
    const db = oneSeries();
    const api = fakeApi({ signedIn: false });
    const result = await reconcileSeries(db, "S1", { api });

    expect(result.outcome).toBe("signed-out");
    expect(api.calls).toEqual([]);
    expect(db.updates).toEqual([]);
  });

  test("creates the subscription once on a 404, then retries the push", async () => {
    // Arrange — the user watched an episode of a title they never subscribed
    // to. PATCH answers "Subscription not found".
    const db = oneSeries();
    const api = fakeApi({
      mark: [
        { ok: false, status: 404, message: "Subscription not found" },
        { ok: true, status: 200 },
      ],
    });

    // Act
    const result = await reconcileSeries(db, "S1", { api });

    // Assert
    expect(result.outcome).toBe("pushed");
    expect(api.calls.map((c) => c.kind)).toEqual(["mark", "create", "mark"]);
    expect(getSyncFailure("S1")).toBeNull();
  });

  test("does not leave a stale sync memory behind when the push fails", async () => {
    const db = oneSeries();
    const api = fakeApi({ mark: { ok: false, status: 500, message: "boom" } });

    const result = await reconcileSeries(db, "S1", { api });

    expect(result.outcome).toBe("deferred");
    expect(db.updates).toEqual([]);
  });
});

// ─── CG2 end to end ─────────────────────────────────────────────────────────

describe("CG2 — reported on the first failure, stopped after MAX_PUSH_ATTEMPTS", () => {
  function badBinding() {
    return fakeDb({
      series: [{ id: "S1", anilistId: 154587, lastSyncedEpisode: 0 }],
      episodes: [main("e1", "S1", 1)],
      progress: [done("e1", "S1")],
      overrides: [],
    });
  }

  test("a 400 'Episode exceeds the total episode count' is capped, not retried forever", async () => {
    // Arrange — Lane A's new upper-bound rejection: the local binding points
    // at the wrong show. Retrying cannot fix it.
    const db = badBinding();
    const api = fakeApi({
      mark: { ok: false, status: 400, message: "Episode exceeds the total episode count" },
    });

    // Act — every trigger firing over and over.
    const outcomes: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      outcomes.push((await reconcileSeries(db, "S1", { api })).outcome);
    }

    // Assert — three real attempts, then the ceiling holds.
    expect(outcomes).toEqual([
      "rejected",
      "rejected",
      "rejected",
      "blocked",
      "blocked",
      "blocked",
    ]);
    expect(api.calls.filter((c) => c.kind === "mark")).toHaveLength(MAX_PUSH_ATTEMPTS);
  });

  test("THE FIRST DETERMINISTIC FAILURE IS ANNOUNCED — T7's whole point", async () => {
    // Arrange — the reported bug: a series failing every push with a 400, and
    // a reader who never saw anything because the announcement waited for a
    // third failure inside one session that their viewing rhythm never had.
    const db = badBinding();
    const api = fakeApi({ mark: { ok: false, status: 400, message: "Episode exceeds the total episode count" } });
    const seen: SyncFailure[] = [];
    const off = onSyncFailure((f) => seen.push(f));

    // Act — ONE trigger. This is a whole session for a reader who watches an
    // episode and closes the tab.
    await reconcileSeries(db, "S1", { api });
    off();

    // Assert — they are told, on the first refusal, while the series is still
    // being retried.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      seriesId: "S1",
      attempts: REPORT_AT_ATTEMPT,
      reportable: true,
      blocked: false,
      status: 400,
      message: "Episode exceeds the total episode count",
    });
  });

  test("the second and third failures do not re-announce the same series", async () => {
    // Arrange
    const db = badBinding();
    const api = fakeApi({ mark: { ok: false, status: 400, message: "Episode exceeds the total episode count" } });
    const seen: SyncFailure[] = [];
    const off = onSyncFailure((f) => seen.push(f));

    // Act — every trigger firing over and over inside one session.
    for (let i = 0; i < 5; i += 1) await reconcileSeries(db, "S1", { api });
    off();

    // Assert — still exactly one event, so the UI shows one toast rather than
    // three. The stored state kept moving underneath it.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ attempts: 1, reportable: true });
    expect(getSyncFailure("S1")).toMatchObject({
      seriesId: "S1",
      attempts: MAX_PUSH_ATTEMPTS,
      reportable: false,
      blocked: true,
      status: 400,
      message: "Episode exceeds the total episode count",
    });
    expect(listSyncFailures()).toHaveLength(1);
  });

  test("a series healed then broken again is announced again", async () => {
    // Arrange — a report is per RUN of failures, not per session: a success
    // clears the entry, so a later fault is news and must be said out loud.
    const progress = [done("e1", "S1")];
    const db = fakeDb({
      series: [{ id: "S1", anilistId: 154587, lastSyncedEpisode: 0 }],
      episodes: [main("e1", "S1", 1), main("e2", "S1", 2)],
      progress,
      overrides: [],
    });
    const seen: SyncFailure[] = [];
    const off = onSyncFailure((f) => seen.push(f));

    // Act — episode 1 is refused…
    await reconcileSeries(db, "S1", {
      api: fakeApi({ mark: { ok: false, status: 400, message: "nope" } }),
    });
    // …then accepted, which clears the failure…
    expect((await reconcileSeries(db, "S1", { api: fakeApi() })).outcome).toBe("pushed");
    expect(getSyncFailure("S1")).toBeNull();
    // …then the reader finishes episode 2 and that push is refused.
    progress.push(done("e2", "S1"));
    await reconcileSeries(db, "S1", {
      api: fakeApi({ mark: { ok: false, status: 400, message: "nope again" } }),
    });
    off();

    // Assert
    expect(seen).toHaveLength(2);
    expect(seen.map((f) => f.message)).toEqual(["nope", "nope again"]);
    expect(seen.every((f) => f.reportable && f.attempts === REPORT_AT_ATTEMPT)).toBe(true);
  });

  test("being offline for a hundred triggers never blocks OR announces", async () => {
    const db = badBinding();
    const api = fakeApi({ mark: { ok: false, status: null, message: "fetch failed" } });
    const seen: SyncFailure[] = [];
    const off = onSyncFailure((f) => seen.push(f));

    for (let i = 0; i < 100; i += 1) await reconcileSeries(db, "S1", { api });
    off();

    expect(getSyncFailure("S1")).toBeNull();
    expect(seen).toEqual([]);
    expect(api.calls).toHaveLength(100);
  });

  test("a rate-limited or 5xx reader is never told their sync is broken", async () => {
    // 429 and 503 are 4xx/5xx by number and transient by meaning. Now that the
    // FIRST failure reports, a mis-classification here would put an error in
    // front of a reader whose only problem was a busy server.
    for (const status of [408, 425, 429, 500, 502, 503]) {
      resetWatchSyncState();
      const db = badBinding();
      const api = fakeApi({ mark: { ok: false, status, message: `HTTP ${status}` } });
      const seen: SyncFailure[] = [];
      const off = onSyncFailure((f) => seen.push(f));

      for (let i = 0; i < 4; i += 1) await reconcileSeries(db, "S1", { api });
      off();

      expect(seen).toEqual([]);
      expect(getSyncFailure("S1")).toBeNull();
      // …and the budget was never spent, so it is still being retried.
      expect(api.calls).toHaveLength(4);
    }
  });

  test("an expired session is never announced either", async () => {
    // 401 is not a failure at all — the fix is a login, not a message about a
    // broken series.
    const db = badBinding();
    const api = fakeApi({ mark: { ok: false, status: 401, message: "Please log in again" } });
    const seen: SyncFailure[] = [];
    const off = onSyncFailure((f) => seen.push(f));

    for (let i = 0; i < 10; i += 1) await reconcileSeries(db, "S1", { api });
    off();

    expect(seen).toEqual([]);
    expect(getSyncFailure("S1")).toBeNull();
    expect(api.calls).toHaveLength(10);
  });

  test("a 401 defers instead of failing, so a re-login pushes the same value", async () => {
    // Arrange
    const db = badBinding();
    const expired = fakeApi({ mark: { ok: false, status: 401, message: "Please log in again" } });

    // Act — session expired for a while…
    for (let i = 0; i < 5; i += 1) {
      expect((await reconcileSeries(db, "S1", { api: expired })).outcome).toBe("deferred");
    }
    // …then the user logs back in and the next trigger fires.
    const restored = fakeApi();
    const after = await reconcileSeries(db, "S1", { api: restored });

    // Assert
    expect(getSyncFailure("S1")).toBeNull();
    expect(after.outcome).toBe("pushed");
    expect(restored.calls).toEqual([{ kind: "mark", anilistId: 154587, episodes: [1] }]);
  });

  test("a later success clears the accrued failures", async () => {
    const db = badBinding();
    await reconcileSeries(db, "S1", {
      api: fakeApi({ mark: { ok: false, status: 400, message: "nope" } }),
    });
    expect(getSyncFailure("S1")?.attempts).toBe(1);

    await reconcileSeries(db, "S1", { api: fakeApi() });
    expect(getSyncFailure("S1")).toBeNull();
  });
});

// ─── unsubscribe → re-subscribe, end to end ─────────────────────────────────

describe("a replaced subscription heals; a deliberate unmark does not come back", () => {
  /** Watched 1-5 locally, pushed 5 to the subscription created at T1. */
  function syncedToFive(over: Partial<WatchSyncSeries> = {}) {
    return fakeDb({
      series: [
        {
          id: "S1",
          anilistId: 154587,
          lastSyncedEpisode: 5,
          lastSyncedSubscribedAt: T1,
          ...over,
        },
      ],
      episodes: [1, 2, 3, 4, 5].map((n) => main(`e${n}`, "S1", n)),
      progress: [1, 2, 3, 4, 5].map((n) => done(`e${n}`, "S1")),
      overrides: [],
    });
  }

  test("the reported sequence: push 5, unsubscribe, re-subscribe, push 5 again", async () => {
    // Arrange — the local library still holds every episode they watched, and
    // the server holds a brand new row at zero.
    const db = syncedToFive();
    const api = fakeApi({ subscriptions: [serverSub(154587, 0, T2)] });

    // Act
    const result = await reconcileSeries(db, "S1", { api });

    // Assert — it pushes rather than reporting already-synced.
    expect(result).toEqual({
      seriesId: "S1",
      outcome: "pushed",
      episodes: [1, 2, 3, 4, 5],
      episode: 5,
      anilistId: 154587,
    });
    expect(api.calls).toEqual([{ kind: "mark", anilistId: 154587, episodes: [1, 2, 3, 4, 5] }]);
    // The memory is rewritten against the NEW row, both fields together, so a
    // reload cannot find one of them describing a subscription that is gone.
    expect(db.updates).toEqual([
      { id: "S1", lastSyncedEpisodes: [], lastSyncedEpisode: 0, lastSyncedSubscribedAt: T2 },
      { id: "S1", lastSyncedEpisodes: [1, 2, 3, 4, 5], lastSyncedEpisode: 5 },
    ]);
  });

  test("an intentional unmark is NOT undone by the reconciler", async () => {
    // Arrange — the reader unchecked episode 5 on the detail page. The set is
    // now {1,2,3,4}, so current_episode fell to 4 — but the subscription row
    // is the same row, and created_at proves it.
    const db = syncedToFive();
    const api = fakeApi({ subscriptions: [serverSub(154587, 4, T1)] });

    // Act — every trigger firing, repeatedly.
    const outcomes: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      outcomes.push((await reconcileSeries(db, "S1", { api })).outcome);
    }

    // Assert — nothing is re-marked, ever. A PATCH here would INSERT episode 5
    // straight back into episode_watches (migration 0024) and put the
    // checkmark the reader removed back on their screen.
    expect(outcomes).toEqual(["already-synced", "already-synced", "already-synced", "already-synced"]);
    expect(api.calls).toEqual([]);
    expect(db.updates).toEqual([]);
  });

  test("the steady state still short-circuits — this never becomes a PATCH per pass", async () => {
    // Arrange — nothing has changed anywhere.
    const db = syncedToFive();
    const api = fakeApi({ subscriptions: [serverSub(154587, 5, T1)] });

    // Act
    for (let i = 0; i < 5; i += 1) {
      expect((await reconcileSeries(db, "S1", { api })).outcome).toBe("already-synced");
    }

    // Assert — no write, ever, and nothing rewritten locally either. The cost
    // of the audit is one GET per pass, and that is the whole cost: the
    // short-circuit survives as the bandwidth optimisation it always was.
    expect(api.calls).toEqual([]);
    expect(db.updates).toEqual([]);
    expect(api.listCalls).toBe(5);
  });

  test("re-reads on the NEXT pass, so a same-session unsubscribe still heals", async () => {
    // Arrange — the literal reported repro: unsubscribe on the detail page and
    // re-subscribe, all without reloading the tab. A snapshot cached for the
    // session would still be holding the pre-unsubscribe answer here.
    const db = syncedToFive();
    let server = serverSub(154587, 5, T1);
    const api: SubscriptionSyncApi & { calls: FakeCall[] } = {
      calls: [],
      isSignedIn: () => true,
      async markEpisodes(anilistId, episodes) {
        this.calls.push({ kind: "mark", anilistId, episodes: [...episodes] });
        return { ok: true, status: 200 };
      },
      async createIfAbsent(anilistId) {
        this.calls.push({ kind: "create", anilistId });
        return { ok: true, status: 201 };
      },
      async listSubscriptions() {
        return [server];
      },
    };

    // Act — pass one sees the healthy row; then the reader churns the
    // subscription; then pass two runs in the SAME module session.
    expect((await reconcileSeries(db, "S1", { api })).outcome).toBe("already-synced");
    server = serverSub(154587, 0, T2);
    const after = await reconcileSeries(db, "S1", { api });

    // Assert
    expect(after).toMatchObject({ outcome: "pushed", episode: 5 });
    expect(api.calls).toEqual([{ kind: "mark", anilistId: 154587, episodes: [1, 2, 3, 4, 5] }]);
  });

  test("a changed identity carrying ANY progress does not trigger a re-push", async () => {
    // The negative case for the invalidation. 4 is the sharp one: the new row
    // could be another device catching up, or it could be the reader having
    // unchecked episode 5 on the new row. Pushing 5 re-marks it in the second,
    // so a changed identity alone is not licence — only an empty row is.
    for (const currentEpisode of [1, 4, 5, 6]) {
      resetWatchSyncState();
      const db = syncedToFive();
      const api = fakeApi({ subscriptions: [serverSub(154587, currentEpisode, T2)] });

      expect((await reconcileSeries(db, "S1", { api })).outcome).toBe("already-synced");
      expect(api.calls).toEqual([]);
      // It does adopt the live row's identity, so a LATER replacement of that
      // row is still provable.
      expect(db.updates).toEqual([{ id: "S1", lastSyncedSubscribedAt: T2 }]);
    }
  });

  test("two overlapping passes share one read rather than racing to two", async () => {
    // Trigger 1 (an episode completing) can land while trigger 3 (the player's
    // entry reconcile) is still in flight. `_snapshotPending` is what keeps
    // that from becoming two account reads.
    const db = syncedToFive();
    let reads = 0;
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api: SubscriptionSyncApi & { calls: FakeCall[] } = {
      calls: [],
      isSignedIn: () => true,
      async markEpisodes(anilistId, episodes) {
        this.calls.push({ kind: "mark", anilistId, episodes: [...episodes] });
        return { ok: true, status: 200 };
      },
      async createIfAbsent(anilistId) {
        this.calls.push({ kind: "create", anilistId });
        return { ok: true, status: 201 };
      },
      async listSubscriptions() {
        reads += 1;
        await gate;
        return [serverSub(154587, 0, T2)];
      },
    };

    // Act — both in flight before either read resolves.
    const both = Promise.all([
      reconcileSeries(db, "S1", { api }),
      reconcileSeries(db, "S1", { api }),
    ]);
    (release as unknown as () => void)();
    const [first, second] = await both;

    // Assert — one read served both passes, and the replacement was healed
    // exactly once. The loser does not push again: by the time it re-reads the
    // memory the winner has already written the new identity and the pushed
    // episode back onto the row, so it correctly finds nothing to do.
    expect(reads).toBe(1);
    expect(api.calls).toEqual([{ kind: "mark", anilistId: 154587, episodes: [1, 2, 3, 4, 5] }]);
    expect([first.outcome, second.outcome].sort()).toEqual(["already-synced", "pushed"]);
  });

  test("adopts the identity it observes, so the NEXT replacement is provable", async () => {
    // Arrange — a row synced before identities were recorded at all.
    const db = syncedToFive({ lastSyncedSubscribedAt: undefined });
    const first = fakeApi({ subscriptions: [serverSub(154587, 5, T1)] });

    // Act — the first observation is bookkeeping and decides nothing.
    const before = await reconcileSeries(db, "S1", { api: first });

    // Assert
    expect(before.outcome).toBe("already-synced");
    expect(first.calls).toEqual([]);
    expect(db.updates).toEqual([{ id: "S1", lastSyncedSubscribedAt: T1 }]);

    // Act — reload, and by now the subscription has been replaced elsewhere.
    resetWatchSyncState();
    const second = fakeApi({ subscriptions: [serverSub(154587, 0, T2)] });
    const after = await reconcileSeries(db, "S1", { api: second });

    // Assert
    expect(after).toMatchObject({ outcome: "pushed", episode: 5 });
    expect(second.calls).toEqual([{ kind: "mark", anilistId: 154587, episodes: [1, 2, 3, 4, 5] }]);
  });

  test("an unmark during the bootstrap window is still not undone", async () => {
    // Arrange — the sharpest case. The identity was never recorded, so there
    // is nothing to compare, AND the server sits below the memory because the
    // reader unchecked episode 5. A rule that pushed on "server is lower"
    // would re-mark it here, with no identity available to say otherwise.
    const db = syncedToFive({ lastSyncedSubscribedAt: undefined });
    const api = fakeApi({ subscriptions: [serverSub(154587, 4, T1)] });

    // Act
    const result = await reconcileSeries(db, "S1", { api });

    // Assert — an absent identity is never treated as a changed one.
    expect(result.outcome).toBe("already-synced");
    expect(api.calls).toEqual([]);
    // It does record what it saw, so the reader's NEXT churn is provable.
    expect(db.updates).toEqual([{ id: "S1", lastSyncedSubscribedAt: T1 }]);
  });

  test("a series the reader unsubscribed from and did not re-add is left alone", async () => {
    // Arrange — no row in the snapshot at all.
    const db = syncedToFive();
    const api = fakeApi({ subscriptions: [] });

    // Act
    const result = await reconcileSeries(db, "S1", { api });

    // Assert — pushing would 404, and pushAndRecord's 404 recovery would
    // re-create the very subscription they deleted.
    expect(result.outcome).toBe("already-synced");
    expect(api.calls).toEqual([]);
    expect(db.updates).toEqual([]);
  });

  test("never asks the server anything on behalf of a signed-out visitor", async () => {
    const db = syncedToFive();
    const api = fakeApi({ signedIn: false, subscriptions: [serverSub(154587, 0, T2)] });

    expect((await reconcileSeries(db, "S1", { api })).outcome).toBe("already-synced");
    expect(api.listCalls).toBe(0);
    expect(api.calls).toEqual([]);
  });

  test("an unreadable snapshot changes nothing, and a later trigger may retry", async () => {
    // Offline, 401, 5xx — all `null`. The memory stands, and a later trigger
    // is still allowed to try, the way ensureSubscription treats a blip.
    const db = syncedToFive();
    const api = fakeApi({ subscriptions: null });

    for (let i = 0; i < 3; i += 1) {
      expect((await reconcileSeries(db, "S1", { api })).outcome).toBe("already-synced");
    }
    expect(api.calls).toEqual([]);
    expect(api.listCalls).toBe(3);
  });

  test("a failing read is attempted ONCE per pass, not once per series", async () => {
    // Arrange — an offline /library mount over several series. "Does not
    // latch" must mean "the next trigger may try", never "ask again for every
    // card on this page".
    const db = fakeDb({
      series: [],
      episodes: ["A", "B", "C", "D"].map((id) => main(`${id}1`, id, 1)),
      progress: [],
      overrides: [],
    });
    const api = fakeApi({ subscriptions: null });
    const input = {
      progress: ["A", "B", "C", "D"].map((id) => done(`${id}1`, id)),
      series: ["A", "B", "C", "D"].map((id, i) => ({
        id,
        anilistId: 10 + i,
        lastSyncedEpisode: 1,
        lastSyncedSubscribedAt: T1,
      })),
      overrides: [],
    };

    // Act
    const first = await reconcileLibrary(db, input, { api });

    // Assert — four series, one request.
    expect(first.map((r) => r.outcome)).toEqual([
      "already-synced",
      "already-synced",
      "already-synced",
      "already-synced",
    ]);
    expect(api.listCalls).toBe(1);
    expect(api.calls).toEqual([]);

    // Act — a second pass is a new trigger, so it gets one more attempt.
    await reconcileLibrary(db, input, { api });

    // Assert
    expect(api.listCalls).toBe(2);
  });

  test("a healed push is still subject to the attempt ceiling", async () => {
    // Arrange — the binding points at the wrong show, so the push that the
    // invalidation unlocks fails deterministically. Being unsubscribed must
    // not buy a series a fresh retry budget.
    const db = syncedToFive();
    const api = fakeApi({
      subscriptions: [serverSub(154587, 0, T2)],
      mark: { ok: false, status: 400, message: "Episode exceeds the total episode count" },
    });

    // Act
    const outcomes: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      outcomes.push((await reconcileSeries(db, "S1", { api })).outcome);
    }

    // Assert
    expect(outcomes).toEqual(["rejected", "rejected", "rejected", "blocked", "blocked"]);
    expect(api.calls.filter((c) => c.kind === "mark")).toHaveLength(MAX_PUSH_ATTEMPTS);
  });

  test("reconcileLibrary heals a whole library through ONE account read", async () => {
    // Arrange — the cross-device case: both titles were unsubscribed and
    // re-subscribed on another device, and this one only opens /library.
    const db = fakeDb({
      series: [],
      episodes: [main("a1", "A", 1), main("a2", "A", 2), main("b1", "B", 1)],
      progress: [],
      overrides: [],
    });
    const api = fakeApi({
      subscriptions: [serverSub(11, 0, T2), serverSub(22, 0, T2)],
    });

    // Act
    const results = await reconcileLibrary(
      db,
      {
        progress: [done("a1", "A"), done("a2", "A"), done("b1", "B")],
        series: [
          { id: "A", anilistId: 11, lastSyncedEpisode: 2, lastSyncedSubscribedAt: T1 },
          { id: "B", anilistId: 22, lastSyncedEpisode: 1, lastSyncedSubscribedAt: T1 },
        ],
        overrides: [],
      },
      { api },
    );

    // Assert — both push, and the snapshot was fetched once for the whole loop.
    expect(results.map((r) => `${r.seriesId}:${r.outcome}:${r.episode}`)).toEqual([
      "A:pushed:2",
      "B:pushed:1",
    ]);
    expect(api.calls).toEqual([
      { kind: "mark", anilistId: 11, episodes: [1, 2] },
      { kind: "mark", anilistId: 22, episodes: [1] },
    ]);
    expect(api.listCalls).toBe(1);
  });

  test("reconcileLibrary leaves an unmarked title alone while healing its neighbour", async () => {
    // Arrange — A was replaced; B is the same row with episode 1 unchecked.
    const db = fakeDb({
      series: [],
      episodes: [main("a1", "A", 1), main("b1", "B", 1)],
      progress: [],
      overrides: [],
    });
    const api = fakeApi({
      subscriptions: [serverSub(11, 0, T2), serverSub(22, 0, T1)],
    });

    // Act
    const results = await reconcileLibrary(
      db,
      {
        progress: [done("a1", "A"), done("b1", "B")],
        series: [
          { id: "A", anilistId: 11, lastSyncedEpisode: 1, lastSyncedSubscribedAt: T1 },
          { id: "B", anilistId: 22, lastSyncedEpisode: 1, lastSyncedSubscribedAt: T1 },
        ],
        overrides: [],
      },
      { api },
    );

    // Assert — identical numbers on both, opposite verdicts, and only the
    // identity tells them apart.
    expect(results.map((r) => `${r.seriesId}:${r.outcome}`)).toEqual([
      "A:pushed",
      "B:already-synced",
    ]);
    expect(api.calls).toEqual([{ kind: "mark", anilistId: 11, episodes: [1] }]);
  });
});

// ─── the reported gap: everything below the high-water mark ─────────────────

/**
 * A fake that HOLDS a watched set and unions into it, the way
 * PUT /api/subscriptions/{id}/episodes does.
 *
 * The tests below are about what the server ends up holding, not about what
 * request went out, and asserting on the request would let a change to the
 * endpoint's union/replace semantics pass here unnoticed. This models the
 * contract instead: `markEpisodes` can only add.
 */
function serverHolding(anilistId: number, initial: number[], subscribedAt: number | null) {
  const watched = new Set(initial);
  const api: FakeApi = {
    calls: [],
    listCalls: 0,
    isSignedIn: () => true,
    async markEpisodes(id, episodes) {
      api.calls.push({ kind: "mark", anilistId: id, episodes: [...episodes] });
      for (const n of episodes) watched.add(n);
      return { ok: true, status: 200 };
    },
    async createIfAbsent(id) {
      api.calls.push({ kind: "create", anilistId: id });
      return { ok: true, status: 201 };
    },
    async listSubscriptions() {
      api.listCalls += 1;
      return [
        {
          anilistId,
          currentEpisode: watched.size ? Math.max(...watched) : 0,
          subscribedAt,
        },
      ];
    },
  };
  return {
    api,
    /** The set as the server now holds it, ascending. */
    watched: () => [...watched].sort((a, b) => a - b),
    unmark: (n: number) => watched.delete(n),
  };
}

describe("the episodes below the high-water mark", () => {
  /**
   * The reported library: nine episodes on disk, five of them finished, and
   * they are not a prefix — 3, 5, 7, 8, 9. The gaps are the point.
   */
  function scatteredLibrary(memory: Partial<WatchSyncSeries> = {}) {
    const watched = [3, 5, 7, 8, 9];
    return fakeDb({
      series: [{ id: "S1", anilistId: 186497, ...memory }],
      episodes: Array.from({ length: 9 }, (_, i) => main(`e${i + 1}`, "S1", i + 1)),
      progress: watched.map((n) => done(`e${n}`, "S1")),
      overrides: [],
    });
  }

  test("THE REPORTED CASE: local {3,5,7,8,9}, server {9} → the server holds all five", async () => {
    // Arrange — episode 9 was marked from somewhere else (the website's grid,
    // another device), and this device has pushed nothing. The library sheet
    // counts five; the episode grid counts one; both read the same reader.
    const db = scatteredLibrary();
    const server = serverHolding(186497, [9], T1);

    // Act — one pass of any trigger.
    const result = await reconcileSeries(db, "S1", { api: server.api });

    // Assert — the two counters now agree, and they agree at five.
    expect(server.watched()).toEqual([3, 5, 7, 8, 9]);
    expect(result).toMatchObject({ outcome: "pushed", episodes: [3, 5, 7, 8, 9], episode: 9 });
    // ONE request for five episodes. Fifty for a two-cour series is what this
    // endpoint exists to prevent.
    expect(server.api.calls).toHaveLength(1);
  });

  test("the second pass sends nothing at all — no request, not a no-op request", async () => {
    const db = scatteredLibrary();
    const server = serverHolding(186497, [9], T1);

    await reconcileSeries(db, "S1", { api: server.api });
    const before = server.api.calls.length;
    for (let i = 0; i < 4; i += 1) {
      expect((await reconcileSeries(db, "S1", { api: server.api })).outcome).toBe("already-synced");
    }

    expect(server.api.calls).toHaveLength(before);
    expect(server.watched()).toEqual([3, 5, 7, 8, 9]);
  });

  test("AN UNMARK ON THE WEBSITE IS NOT RESURRECTED, anywhere in the set", async () => {
    // Arrange — a full sync, then the reader unchecks a MIDDLE episode on the
    // site. current_episode does not even move, so nothing about the numbers
    // has changed; only the set has.
    const db = scatteredLibrary();
    const server = serverHolding(186497, [], T1);
    await reconcileSeries(db, "S1", { api: server.api });
    expect(server.watched()).toEqual([3, 5, 7, 8, 9]);

    server.unmark(5);

    // Act — every trigger firing, repeatedly.
    for (let i = 0; i < 5; i += 1) {
      expect((await reconcileSeries(db, "S1", { api: server.api })).outcome).toBe("already-synced");
    }

    // Assert — episode 5 stays gone. Not because the reconciler noticed the
    // unmark (it never asked), but because 5 is in the memory and the memory
    // is what it subtracts.
    expect(server.watched()).toEqual([3, 7, 8, 9]);
  });

  test("unmarking the TOP episode is not resurrected either", async () => {
    // The case a "the server is behind us, so push" rule gets wrong, now
    // stated over sets: the maximum falls from 9 to 8 and nothing is re-sent.
    const db = scatteredLibrary();
    const server = serverHolding(186497, [], T1);
    await reconcileSeries(db, "S1", { api: server.api });
    server.unmark(9);

    expect((await reconcileSeries(db, "S1", { api: server.api })).outcome).toBe("already-synced");
    expect(server.watched()).toEqual([3, 5, 7, 8]);
  });

  test("a NEW episode still syncs while the unmarked one stays unmarked", async () => {
    // "Leaves it alone" must not mean "gives up on the series".
    const db = scatteredLibrary();
    const server = serverHolding(186497, [], T1);
    await reconcileSeries(db, "S1", { api: server.api });
    server.unmark(5);

    // The reader finishes episode 4 locally. Rebuilt rather than mutated,
    // carrying the memory the first pass wrote.
    const withFour = fakeDb({
      series: [{ id: "S1", anilistId: 186497, lastSyncedEpisodes: [3, 5, 7, 8, 9], lastSyncedEpisode: 9 }],
      episodes: Array.from({ length: 9 }, (_, i) => main(`e${i + 1}`, "S1", i + 1)),
      progress: [3, 4, 5, 7, 8, 9].map((n) => done(`e${n}`, "S1")),
      overrides: [],
    });

    const result = await reconcileSeries(withFour, "S1", { api: server.api });

    expect(result).toMatchObject({ outcome: "pushed", episodes: [4] });
    expect(server.watched()).toEqual([3, 4, 7, 8, 9]);
  });

  test("AN UPGRADING READER PUSHES NOTHING — a scalar memory is not an empty one", async () => {
    // Arrange — a row written by the build before this change: a maximum, no
    // set. Every local episode sits at or below it.
    const db = fakeDb({
      series: [{ id: "S1", anilistId: 186497, lastSyncedEpisode: 9, lastSyncedSubscribedAt: T1 }],
      episodes: Array.from({ length: 9 }, (_, i) => main(`e${i + 1}`, "S1", i + 1)),
      progress: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => done(`e${n}`, "S1")),
      overrides: [],
    });
    // The server as migration 0024's backfill leaves it: 1..N, promoted from
    // the current_episode the old push wrote.
    const server = serverHolding(186497, [1, 2, 3, 4, 5, 6, 7, 8, 9], T1);

    // Act
    const result = await reconcileSeries(db, "S1", { api: server.api });

    // Assert — no writes, and no local rewrite either. The upgrade is silent.
    expect(result.outcome).toBe("already-synced");
    expect(server.api.calls).toEqual([]);
    expect(db.updates).toEqual([]);
  });

  test("an upgrading reader's whole LIBRARY pushes nothing, through one read", async () => {
    // The volume claim, since the scalar→set migration is the moment a
    // mistake here would cost every reader a burst of writes on one mount.
    const ids = ["A", "B", "C", "D", "E"];
    const db = fakeDb({
      series: [],
      episodes: ids.flatMap((id) => [1, 2, 3].map((n) => main(`${id}${n}`, id, n))),
      progress: [],
      overrides: [],
    });
    const api = fakeApi({
      subscriptions: ids.map((_, i) => serverSub(10 + i, 3, T1)),
    });

    const results = await reconcileLibrary(
      db,
      {
        progress: ids.flatMap((id) => [1, 2, 3].map((n) => done(`${id}${n}`, id))),
        // Legacy rows: a maximum of 3, and no set anywhere.
        series: ids.map((id, i) => ({ id, anilistId: 10 + i, lastSyncedEpisode: 3, lastSyncedSubscribedAt: T1 })),
        overrides: [],
      },
      { api },
    );

    expect(results.map((r) => r.outcome)).toEqual(ids.map(() => "already-synced"));
    expect(api.calls).toEqual([]);
    expect(db.updates).toEqual([]);
    // The one account-wide GET the previous change added, and nothing else —
    // no per-series read was introduced to answer "what does the server hold".
    expect(api.listCalls).toBe(1);
  });

  test("a replaced subscription re-pushes the WHOLE set, gaps and all", async () => {
    // Composes with lastSyncedSubscribedAt rather than duplicating it: the
    // identity check is untouched, and clearing the memory it guards now
    // clears a set instead of a number.
    const db = scatteredLibrary({
      lastSyncedEpisodes: [3, 5, 7, 8, 9],
      lastSyncedEpisode: 9,
      lastSyncedSubscribedAt: T1,
    });
    // Unsubscribed and re-subscribed: episode_watches cascaded away with the
    // old row, so the new one is empty and created_at moved.
    const server = serverHolding(186497, [], T2);

    const result = await reconcileSeries(db, "S1", { api: server.api });

    expect(result).toMatchObject({ outcome: "pushed", episodes: [3, 5, 7, 8, 9] });
    expect(server.watched()).toEqual([3, 5, 7, 8, 9]);
    expect(db.updates).toEqual([
      { id: "S1", lastSyncedEpisodes: [], lastSyncedEpisode: 0, lastSyncedSubscribedAt: T2 },
      { id: "S1", lastSyncedEpisodes: [3, 5, 7, 8, 9], lastSyncedEpisode: 9 },
    ]);
  });

  test("the memory grows by union, so a lost local episode is not re-offered", async () => {
    // Arrange — synced {3,5,7,8,9}, then a rescan loses the file for 5.
    const synced = { lastSyncedEpisodes: [3, 5, 7, 8, 9], lastSyncedEpisode: 9 };
    const afterRescan = fakeDb({
      series: [{ id: "S1", anilistId: 186497, ...synced }],
      episodes: [3, 7, 8, 9, 10].map((n) => main(`e${n}`, "S1", n)),
      progress: [3, 7, 8, 9, 10].map((n) => done(`e${n}`, "S1")),
      overrides: [],
    });
    const server = serverHolding(186497, [3, 5, 7, 8, 9], T1);

    // Act — episode 10 is new; 5 is no longer on disk.
    const result = await reconcileSeries(afterRescan, "S1", { api: server.api });

    // Assert — 10 goes, 5 is neither re-sent nor forgotten. A memory that
    // tracked the local set would drop 5 here and re-offer it the moment the
    // file came back, undoing an unmark the reader may have made in between.
    expect(result).toMatchObject({ episodes: [10] });
    expect(server.watched()).toEqual([3, 5, 7, 8, 9, 10]);
    expect(afterRescan.updates).toEqual([
      { id: "S1", lastSyncedEpisodes: [3, 5, 7, 8, 9, 10], lastSyncedEpisode: 10 },
    ]);
  });

  test("a merged card pushes one set for the whole group, without duplicates", async () => {
    // Two source series both numbering an episode 1: the server's key is
    // (user, anime, episode), so the request must describe the set it will
    // become rather than the rows it was built from.
    const db = fakeDb({
      series: [{ id: "ROOT", anilistId: 186497 }],
      episodes: [main("r1", "ROOT", 1), main("s1", "SRC", 1), main("s2", "SRC", 2)],
      progress: [done("r1", "ROOT"), done("s1", "SRC"), done("s2", "SRC")],
      overrides: [{ seriesId: "ROOT", mergedFrom: ["SRC"] }],
    });
    const server = serverHolding(186497, [], T1);

    const result = await reconcileSeries(db, "ROOT", { api: server.api });

    expect(result).toMatchObject({ episodes: [1, 2] });
    expect(server.watched()).toEqual([1, 2]);
  });
});

// ─── reconcileLibrary ───────────────────────────────────────────────────────

describe("reconcileLibrary", () => {
  test("pushes every bound series that is ahead, in one episodes read", async () => {
    // Arrange
    const db = fakeDb({
      series: [],
      episodes: [main("a1", "A", 1), main("a2", "A", 2), main("b1", "B", 1)],
      progress: [],
      overrides: [],
    });
    const api = fakeApi();

    // Act
    const results = await reconcileLibrary(
      db,
      {
        progress: [done("a1", "A"), done("a2", "A"), done("b1", "B")],
        series: [
          { id: "A", anilistId: 11, lastSyncedEpisode: 1 },
          { id: "B", anilistId: 22 },
        ],
        overrides: [],
      },
      { api },
    );

    // Assert
    expect(results.map((r) => `${r.seriesId}:${r.outcome}:${r.episode}`)).toEqual([
      "A:pushed:2",
      "B:pushed:1",
    ]);
    expect(api.calls).toEqual([
      { kind: "mark", anilistId: 11, episodes: [2] },
      { kind: "mark", anilistId: 22, episodes: [1] },
    ]);
  });

  test("does nothing at all when no episode has been completed", async () => {
    const db = fakeDb({ series: [], episodes: [], progress: [], overrides: [] });
    const api = fakeApi();

    const results = await reconcileLibrary(
      db,
      {
        progress: [{ episodeId: "a1", seriesId: "A", completed: false }],
        series: [{ id: "A", anilistId: 11 }],
        overrides: [],
      },
      { api },
    );

    expect(results).toEqual([]);
    expect(api.calls).toEqual([]);
  });

  test("folds a merged group onto the root card's binding", async () => {
    // Arrange — the source's own binding (999) must never be used.
    const db = fakeDb({
      series: [],
      episodes: [main("a1", "A", 1), main("s2", "SRC", 2)],
      progress: [],
      overrides: [],
    });
    const api = fakeApi();

    // Act
    const results = await reconcileLibrary(
      db,
      {
        progress: [done("a1", "A"), done("s2", "SRC")],
        // useLibrary hides merged-in sources, so only the root is here.
        series: [{ id: "A", anilistId: 11 }],
        overrides: [{ seriesId: "A", mergedFrom: ["SRC"] }],
      },
      { api },
    );

    // Assert
    expect(results).toEqual([
      { seriesId: "A", outcome: "pushed", episodes: [1, 2], episode: 2, anilistId: 11 },
    ]);
    expect(api.calls).toEqual([{ kind: "mark", anilistId: 11, episodes: [1, 2] }]);
  });

  test("reports unbound series without a request so the card can explain itself", async () => {
    // And WITHOUT resolving them: a mature library can hold hundreds of unbound
    // series, and resolving one is a title search. Opening /library must not
    // become a burst of hundreds of simultaneous searches — on-demand
    // resolution stays on the two single-series paths the user initiated.
    const db = fakeDb({ series: [], episodes: [], progress: [], overrides: [] });
    const api = fakeApi();

    const results = await reconcileLibrary(
      db,
      {
        progress: [done("a1", "A")],
        series: [{ id: "A" }],
        overrides: [],
      },
      // Even if a caller passes one, reconcileLibrary must never resolve.
      { api, resolveBinding: async () => 999 },
    );

    expect(results).toEqual([
      { seriesId: "A", outcome: "unbound", episodes: [], episode: null, anilistId: null },
    ]);
    expect(api.calls).toEqual([]);
  });

  test("skips a series already blocked by the attempt ceiling", async () => {
    // Arrange — burn the budget through the single-series path first.
    const db = fakeDb({
      series: [{ id: "A", anilistId: 11 }],
      episodes: [main("a1", "A", 1)],
      progress: [done("a1", "A")],
      overrides: [],
    });
    const failing = fakeApi({ mark: { ok: false, status: 404, message: "gone" } });
    for (let i = 0; i < MAX_PUSH_ATTEMPTS; i += 1) {
      await reconcileSeries(db, "A", { api: failing });
    }

    // Act
    const api = fakeApi();
    const results = await reconcileLibrary(
      db,
      { progress: [done("a1", "A")], series: [{ id: "A", anilistId: 11 }], overrides: [] },
      { api },
    );

    // Assert
    expect(results).toEqual([
      { seriesId: "A", outcome: "blocked", episodes: [], episode: null, anilistId: 11 },
    ]);
    expect(api.calls).toEqual([]);
  });
});

// ─── T9 ─────────────────────────────────────────────────────────────────────

describe("startTracking", () => {
  function db(over: Partial<WatchSyncSeries> = {}, overrides: WatchSyncOverride[] = []) {
    return fakeDb({
      series: [{ id: "S1", anilistId: 154587, ...over }],
      episodes: [],
      progress: [],
      overrides,
    });
  }

  test("creates an idempotent watching subscription", async () => {
    // Arrange
    const api = fakeApi();

    // Act
    const result = await startTracking(db(), "S1", { api });

    // Assert
    expect(result).toEqual({ seriesId: "S1", outcome: "tracked", anilistId: 154587 });
    expect(api.calls).toEqual([{ kind: "create", anilistId: 154587 }]);
  });

  test("does not track an unbound series and says why", async () => {
    const api = fakeApi();
    const result = await startTracking(db({ anilistId: undefined }), "S1", { api });

    expect(result).toEqual({ seriesId: "S1", outcome: "unbound", anilistId: null });
    expect(api.calls).toEqual([]);
  });

  test("posts at most once per series per session", async () => {
    const api = fakeApi();
    const database = db();
    await startTracking(database, "S1", { api });
    const second = await startTracking(database, "S1", { api });

    expect(second.outcome).toBe("already-attempted");
    expect(api.calls).toHaveLength(1);
  });

  test("tracks the root when a merged-in source id is clicked", async () => {
    const database = fakeDb({
      series: [
        { id: "ROOT", anilistId: 11 },
        { id: "SRC", anilistId: 999 },
      ],
      episodes: [],
      progress: [],
      overrides: [{ seriesId: "ROOT", mergedFrom: ["SRC"] }],
    });
    const api = fakeApi();

    const result = await startTracking(database, "SRC", { api });

    expect(result).toEqual({ seriesId: "ROOT", outcome: "tracked", anilistId: 11 });
    expect(api.calls).toEqual([{ kind: "create", anilistId: 11 }]);
  });

  test("resolves the binding on demand when the series has none yet", async () => {
    // Arrange — the normal state of a freshly imported series: the automatic
    // resolver only ever ran on /library/[seriesId], which the grid never opens.
    const database = db({ anilistId: undefined });
    const api = fakeApi();
    const asked: string[] = [];
    const resolveBinding = async (seriesId: string) => {
      asked.push(seriesId);
      return 154587;
    };

    // Act
    const result = await startTracking(database, "S1", { api, resolveBinding });

    // Assert
    expect(asked).toEqual(["S1"]);
    expect(result).toEqual({ seriesId: "S1", outcome: "tracked", anilistId: 154587 });
    expect(api.calls).toEqual([{ kind: "create", anilistId: 154587 }]);
  });

  test("does not call the resolver when a binding already exists", async () => {
    const api = fakeApi();
    let called = 0;
    await startTracking(db(), "S1", {
      api,
      resolveBinding: async () => {
        called += 1;
        return 1;
      },
    });
    expect(called).toBe(0);
  });

  test("still reports unbound when the resolver finds nothing", async () => {
    const api = fakeApi();
    const result = await startTracking(db({ anilistId: undefined }), "S1", {
      api,
      resolveBinding: async () => null,
    });

    expect(result).toEqual({ seriesId: "S1", outcome: "unbound", anilistId: null });
    expect(api.calls).toEqual([]);
  });

  test("stays quiet for a signed-out visitor", async () => {
    const api = fakeApi({ signedIn: false });
    const result = await startTracking(db(), "S1", { api });

    expect(result.outcome).toBe("signed-out");
    expect(api.calls).toEqual([]);
  });

  test("reports a server refusal instead of pretending", async () => {
    const api = fakeApi({ create: { ok: false, status: 404, message: "Anime not found" } });
    const result = await startTracking(db(), "S1", { api });

    expect(result.outcome).toBe("failed");
  });

  test("a deterministic refusal is not retried on the next click", async () => {
    // "Anime not found" will still be not-found in ten seconds.
    const api = fakeApi({ create: { ok: false, status: 404, message: "Anime not found" } });
    const database = db();
    await startTracking(database, "S1", { api });
    const second = await startTracking(database, "S1", { api });

    expect(second.outcome).toBe("already-attempted");
    expect(api.calls).toHaveLength(1);
  });

  test("a network failure does NOT latch — the next click tries again", async () => {
    // Arrange — one offline click must not disable tracking for the session,
    // including the 404 recovery inside the reconciler.
    const database = db();
    const offline = fakeApi({ create: { ok: false, status: null, message: "fetch failed" } });

    // Act
    const first = await startTracking(database, "S1", { api: offline });
    const online = fakeApi();
    const second = await startTracking(database, "S1", { api: online });

    // Assert
    expect(first.outcome).toBe("failed");
    expect(second.outcome).toBe("tracked");
    expect(online.calls).toEqual([{ kind: "create", anilistId: 154587 }]);
  });
});

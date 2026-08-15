import { beforeEach, describe, expect, test } from "bun:test";

import {
  applyFailure,
  classifyPushFailure,
  decidePush,
  findRootSeriesId,
  getSyncFailure,
  listSyncFailures,
  MAX_PUSH_ATTEMPTS,
  onSyncFailure,
  reconcileLibrary,
  reconcileSeries,
  resetWatchSyncState,
  resolveGroupSeriesIds,
  startTracking,
  type PushResponse,
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
  kind: "patch" | "create";
  anilistId: number;
  currentEpisode?: number;
}

function fakeApi(
  responses: Partial<{
    patch: PushResponse | PushResponse[];
    create: PushResponse;
    signedIn: boolean;
  }> = {},
): SubscriptionSyncApi & { calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const patchQueue = Array.isArray(responses.patch)
    ? [...responses.patch]
    : responses.patch
      ? [responses.patch]
      : [];
  return {
    calls,
    isSignedIn: () => responses.signedIn ?? true,
    async patchProgress(anilistId, currentEpisode) {
      calls.push({ kind: "patch", anilistId, currentEpisode });
      return patchQueue.length > 1
        ? (patchQueue.shift() as PushResponse)
        : (patchQueue[0] ?? { ok: true, status: 200 });
    },
    async createIfAbsent(anilistId) {
      calls.push({ kind: "create", anilistId });
      return responses.create ?? { ok: true, status: 201 };
    },
  };
}

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
    lastSyncedEpisode: 3,
    highWater: 5,
    attempts: 0,
  };

  test("pushes the local high-water mark when it is ahead of the server", () => {
    expect(decidePush(base)).toEqual({
      push: true,
      anilistId: 154587,
      currentEpisode: 5,
    });
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
    expect(decidePush({ ...base, highWater: null })).toEqual({
      push: false,
      reason: "nothing-watched",
    });
  });

  test("does not push when the server already has this episode", () => {
    expect(decidePush({ ...base, highWater: 3 }).push).toBe(false);
    expect(decidePush({ ...base, highWater: 2 })).toEqual({
      push: false,
      reason: "already-synced",
    });
  });

  test("treats a never-synced series as synced-to-zero", () => {
    expect(decidePush({ ...base, lastSyncedEpisode: undefined })).toEqual({
      push: true,
      anilistId: 154587,
      currentEpisode: 5,
    });
  });

  test("stops pushing once the attempt ceiling is reached (CG2)", () => {
    expect(decidePush({ ...base, attempts: MAX_PUSH_ATTEMPTS })).toEqual({
      push: false,
      reason: "blocked",
    });
  });

  test("applies no upper bound — that guard lives on the server (decision 4)", () => {
    expect(decidePush({ ...base, highWater: 9999 }).push).toBe(true);
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

  test("leaves the budget untouched for transient failures", () => {
    const seeded = applyFailure({ ...args, kind: "deterministic" });
    const after = applyFailure({ ...args, prev: seeded, kind: "transient" });
    expect(after?.attempts).toBe(1);
  });

  test("a week offline never exhausts the budget", () => {
    let state: SyncFailure | null = null;
    for (let i = 0; i < 100; i += 1) {
      state = applyFailure({ ...args, prev: state, kind: "transient", status: null });
    }
    expect(state).toBeNull();
  });

  test("an expired session never exhausts the budget either", () => {
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

  test("pushes the high-water mark with monotonic semantics and records it", async () => {
    // Arrange
    const db = oneSeries();
    const api = fakeApi();

    // Act
    const result = await reconcileSeries(db, "S1", { api });

    // Assert
    expect(result).toEqual({
      seriesId: "S1",
      outcome: "pushed",
      episode: 3,
      anilistId: 154587,
    });
    expect(api.calls).toEqual([
      { kind: "patch", anilistId: 154587, currentEpisode: 3 },
    ]);
    expect(db.updates).toEqual([{ id: "S1", lastSyncedEpisode: 3 }]);
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
      episode: 2,
      anilistId: 111,
    });
    expect(api.calls).toEqual([{ kind: "patch", anilistId: 111, currentEpisode: 2 }]);
    expect(db.updates).toEqual([{ id: "S1", lastSyncedEpisode: 2 }]);
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
      episode: 3,
      anilistId: 154587,
    });
    expect(api.calls).toEqual([{ kind: "patch", anilistId: 154587, currentEpisode: 3 }]);
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
      patch: [
        { ok: false, status: 404, message: "Subscription not found" },
        { ok: true, status: 200 },
      ],
    });

    // Act
    const result = await reconcileSeries(db, "S1", { api });

    // Assert
    expect(result.outcome).toBe("pushed");
    expect(api.calls.map((c) => c.kind)).toEqual(["patch", "create", "patch"]);
    expect(getSyncFailure("S1")).toBeNull();
  });

  test("does not leave a stale lastSyncedEpisode behind when the push fails", async () => {
    const db = oneSeries();
    const api = fakeApi({ patch: { ok: false, status: 500, message: "boom" } });

    const result = await reconcileSeries(db, "S1", { api });

    expect(result.outcome).toBe("deferred");
    expect(db.updates).toEqual([]);
  });
});

// ─── CG2 end to end ─────────────────────────────────────────────────────────

describe("CG2 — a deterministic failure stops after MAX_PUSH_ATTEMPTS", () => {
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
      patch: { ok: false, status: 400, message: "Episode exceeds the total episode count" },
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
    expect(api.calls.filter((c) => c.kind === "patch")).toHaveLength(MAX_PUSH_ATTEMPTS);
  });

  test("the failure is queryable and announced exactly once as blocked", async () => {
    // Arrange
    const db = badBinding();
    const api = fakeApi({ patch: { ok: false, status: 400, message: "Episode exceeds the total episode count" } });
    const seen: SyncFailure[] = [];
    const off = onSyncFailure((f) => seen.push(f));

    // Act
    for (let i = 0; i < 5; i += 1) await reconcileSeries(db, "S1", { api });
    off();

    // Assert — one event per real attempt, and exactly one of them blocked.
    expect(seen).toHaveLength(MAX_PUSH_ATTEMPTS);
    expect(seen.filter((f) => f.blocked)).toHaveLength(1);
    expect(getSyncFailure("S1")).toMatchObject({
      seriesId: "S1",
      attempts: MAX_PUSH_ATTEMPTS,
      blocked: true,
      status: 400,
      message: "Episode exceeds the total episode count",
    });
    expect(listSyncFailures()).toHaveLength(1);
  });

  test("being offline for a hundred triggers never blocks the series", async () => {
    const db = badBinding();
    const api = fakeApi({ patch: { ok: false, status: null, message: "fetch failed" } });

    for (let i = 0; i < 100; i += 1) await reconcileSeries(db, "S1", { api });

    expect(getSyncFailure("S1")).toBeNull();
    expect(api.calls).toHaveLength(100);
  });

  test("a 401 defers instead of failing, so a re-login pushes the same value", async () => {
    // Arrange
    const db = badBinding();
    const expired = fakeApi({ patch: { ok: false, status: 401, message: "Please log in again" } });

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
    expect(restored.calls).toEqual([{ kind: "patch", anilistId: 154587, currentEpisode: 1 }]);
  });

  test("a later success clears the accrued failures", async () => {
    const db = badBinding();
    await reconcileSeries(db, "S1", {
      api: fakeApi({ patch: { ok: false, status: 400, message: "nope" } }),
    });
    expect(getSyncFailure("S1")?.attempts).toBe(1);

    await reconcileSeries(db, "S1", { api: fakeApi() });
    expect(getSyncFailure("S1")).toBeNull();
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
      { kind: "patch", anilistId: 11, currentEpisode: 2 },
      { kind: "patch", anilistId: 22, currentEpisode: 1 },
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
      { seriesId: "A", outcome: "pushed", episode: 2, anilistId: 11 },
    ]);
    expect(api.calls).toEqual([{ kind: "patch", anilistId: 11, currentEpisode: 2 }]);
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
      { seriesId: "A", outcome: "unbound", episode: null, anilistId: null },
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
    const failing = fakeApi({ patch: { ok: false, status: 404, message: "gone" } });
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
      { seriesId: "A", outcome: "blocked", episode: null, anilistId: 11 },
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

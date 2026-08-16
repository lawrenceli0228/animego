// Reconciles the local per-episode tick list against the server's single
// integer `subscription.current_episode`.
//
// THE MODEL (design doc §4 decision 5): state is the truth, not a queue.
// Every push is derived from two numbers that both live in Dexie —
// `resolveHighWater(progress, episodes)` and `series.lastSyncedEpisode` — so
// replaying reconciliation any number of times is safe and an interrupted run
// leaves nothing to clean up. There is no outbox, no retry counter persisted
// anywhere, and there must not be one: Taiga's `history.xml` queue and
// Animeko's server-first mark-as-watched are both strictly worse (Taiga retries
// forever and never reads its own `retry_count`; Animeko drops offline marks on
// the floor). Do not add a queue here.
//
// THREE TRIGGERS (§3.1 / decision 14), all calling into this module:
//   the moment a `completed` row is written  → reconcileSeries(root of that series)
//   entering /library                        → reconcileLibrary(rows already in memory)
//   entering the player with a library series → reconcileSeries(that series)
//
// ─── CG2: the attempt ceiling ───────────────────────────────────────────────
//
// §9 CG2: a PATCH that keeps failing deterministically never advances
// `lastSyncedEpisode`, so all three triggers retry it forever with no backoff
// and nothing the user can see. Two shapes produce it, and Lane A added the
// second one:
//   404  the subscription row does not exist (and, transitively, the title is
//        not in `anime_cache` — the FK guarantees both fail together).
//   400  "Episode exceeds the total episode count" — the local binding points
//        at the wrong show, or at one season of a multi-cour split.
//
// So: at most MAX_PUSH_ATTEMPTS deterministic failures per series, counted in
// memory, plus a queryable failure state the UI renders.
//
// The counter is deliberately NOT persisted and there is no v7 migration for
// it. Both failure causes survive a reload — a wrong binding is still wrong,
// an uncached title is still uncached — so paying three more requests after a
// refresh costs almost nothing. What actually had to die is the "three
// triggers x unbounded retries" loop inside one session, and a Map does that.
// The cost of being wrong here is a handful of extra 4xx per page load; the
// cost of a Dexie table would be a migration, a second source of truth for
// "is this series broken", and a stale row to explain to the next reader.
//
// Transient failures (offline, 5xx, rate limiting) are NOT counted. Those are
// exactly the conditions decision 5 exists to ride out. 401 is not counted
// either and is not a failure at all: the session expired, the user logs back
// in, and the next trigger pushes the same derived value (§8.1 "401 过期→重登
// 后补推").
//
// No Dexie import and no `db` singleton import at module scope: `db.js` throws
// when loaded outside a browser, and every decision below has to stay reachable
// from a plain `bun test`.

import { hasAuthHint } from "@/lib/clientAuth";
import { authFetch } from "@/lib/authFetch";
import { readBinding } from "./animeBinding";
import { resolveHighWater } from "./watchHighWater";

// ─── Row shapes (structural, so tests can hand in plain objects) ────────────

/** The `Series` fields this module reads. See `types.js`. */
export interface WatchSyncSeries {
  readonly id?: string;
  readonly anilistId?: number | null;
  readonly lastSyncedEpisode?: number | null;
}

/** The `Progress` fields this module reads. */
export interface WatchSyncProgress {
  readonly episodeId: string;
  readonly seriesId?: string;
  readonly completed?: boolean;
}

/** The `Episode` fields this module reads. */
export interface WatchSyncEpisode {
  readonly id: string;
  readonly seriesId?: string;
  readonly number: number;
  readonly kind: string;
}

/** The `UserOverride` fields this module reads. */
export interface WatchSyncOverride {
  readonly seriesId?: string;
  readonly mergedFrom?: string[];
}

// ─── Pure decisions ─────────────────────────────────────────────────────────

/** Deterministic failures tolerated per series, per session. */
export const MAX_PUSH_ATTEMPTS = 3;

/**
 * Walk UP the merge graph: which series' card does `seriesId` render on?
 *
 * `performMerge` is a soft merge — the source Series row survives, keeps its
 * episodes, and (this is the dangerous part) keeps whatever `anilistId` it was
 * bound to while it was still its own card. `resolveMergedSeriesIds` walks the
 * other way, from a root down to its sources.
 *
 * Without this, reconciliation over "every series with an anilistId" pushes a
 * merged-in source's progress to the id THAT SOURCE was bound to — a different
 * show, with the server's GREATEST guard making it permanent. Only the root
 * syncs; see `loadSeriesRows.ts`'s `rootSeriesId` for the same rule stated from
 * the reading side.
 *
 * `seen` is cycle protection: `mergedFrom` is user-writable state that survives
 * across versions, and a loop here would hang a page with nothing to read.
 */
export function findRootSeriesId(
  overrides: readonly WatchSyncOverride[] | null | undefined,
  seriesId: string,
): string {
  if (!seriesId) return "";

  // source id → the series it was merged INTO.
  const parentOf = new Map<string, string>();
  for (const o of overrides ?? []) {
    if (!o || typeof o.seriesId !== "string" || !o.seriesId) continue;
    if (!Array.isArray(o.mergedFrom)) continue;
    for (const child of o.mergedFrom) {
      if (typeof child === "string" && child && child !== o.seriesId) {
        parentOf.set(child, o.seriesId);
      }
    }
  }

  let current = seriesId;
  const seen = new Set<string>([current]);
  for (;;) {
    const parent = parentOf.get(current);
    if (!parent || seen.has(parent)) return current;
    seen.add(parent);
    current = parent;
  }
}

/** Every series id whose episodes belong on `rootId`'s card, root first. */
export function resolveGroupSeriesIds(
  overrides: readonly WatchSyncOverride[] | null | undefined,
  rootId: string,
): string[] {
  if (!rootId) return [];
  const childrenOf = new Map<string, string[]>();
  for (const o of overrides ?? []) {
    if (!o || typeof o.seriesId !== "string" || !o.seriesId) continue;
    if (!Array.isArray(o.mergedFrom)) continue;
    const kids = o.mergedFrom.filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    );
    if (kids.length) childrenOf.set(o.seriesId, kids);
  }

  const seen = new Set<string>([rootId]);
  const out = [rootId];
  const queue = [rootId];
  while (queue.length) {
    const current = queue.shift() as string;
    for (const child of childrenOf.get(current) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

export type PushSkipReason =
  | "not-root"
  | "unbound"
  | "nothing-watched"
  | "already-synced"
  | "blocked";

export interface PushPlanned {
  readonly push: true;
  readonly anilistId: number;
  readonly currentEpisode: number;
}
export interface PushSkipped {
  readonly push: false;
  readonly reason: PushSkipReason;
}
export type PushPlan = PushPlanned | PushSkipped;

/**
 * Narrow a plan. A plain `if (plan.push)` does NOT narrow here: this project
 * compiles with `strict: false`, and without `strictNullChecks` TypeScript
 * declines to discriminate a union on a boolean-literal property. An explicit
 * predicate does the job in every mode.
 */
export function isPushPlanned(plan: PushPlan): plan is PushPlanned {
  return plan.push === true;
}

/** AniList ids are positive integers; anything else is not a binding. */
function toAnilistId(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** `undefined` means "never synced", which compares the same as 0 here. */
function toSyncedEpisode(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * The whole push policy, as one pure function.
 *
 * Note what is NOT here: an upper bound. Decision 4 puts that on the server,
 * which holds the authoritative `anime_cache.episodes`; the client's
 * `Series.totalEpisodes` is optional and often wrong, so bounding against it
 * would silently drop legitimate progress.
 */
export function decidePush(input: {
  readonly isRoot: boolean;
  readonly anilistId: unknown;
  readonly lastSyncedEpisode: unknown;
  readonly highWater: number | null;
  readonly attempts: number;
}): PushPlan {
  // First, because a merged-in source can carry a stale binding of its own and
  // pushing it would write another show's progress.
  if (!input.isRoot) return { push: false, reason: "not-root" };

  const anilistId = toAnilistId(input.anilistId);
  if (anilistId === null) return { push: false, reason: "unbound" };

  const { highWater } = input;
  if (highWater === null || !Number.isFinite(highWater)) {
    return { push: false, reason: "nothing-watched" };
  }
  if (highWater <= toSyncedEpisode(input.lastSyncedEpisode)) {
    return { push: false, reason: "already-synced" };
  }
  if (input.attempts >= MAX_PUSH_ATTEMPTS) {
    return { push: false, reason: "blocked" };
  }
  return { push: true, anilistId, currentEpisode: highWater };
}

export type FailureKind = "deterministic" | "transient" | "auth";

/**
 * Does this failure mean "stop trying" or "try again later"?
 *
 * Only a deterministic 4xx accrues. 401 is its own bucket because the fix is a
 * login, not a retry budget, and 408/425/429 are 4xx by number but transient by
 * meaning — go-api answers 429 from its rate limiter, and burning the ceiling
 * on that would disable sync for a user who did nothing wrong.
 */
export function classifyPushFailure(
  status: number | null | undefined,
): FailureKind {
  if (status == null) return "transient"; // network error / offline
  if (status === 401) return "auth";
  if (status === 408 || status === 425 || status === 429) return "transient";
  if (status >= 400 && status < 500) return "deterministic";
  return "transient";
}

export interface SyncFailure {
  readonly seriesId: string;
  readonly attempts: number;
  /** Attempt ceiling reached — nothing else will be pushed this session. */
  readonly blocked: boolean;
  readonly status: number | null;
  readonly message: string;
  readonly at: number;
}

/**
 * Fold one failure into the per-series state. Returns the entry to store, or
 * `null` to store nothing.
 *
 * Transient and auth failures return the previous entry untouched — including
 * `null` — so a week offline cannot exhaust the budget.
 */
export function applyFailure(input: {
  readonly prev: SyncFailure | null | undefined;
  readonly seriesId: string;
  readonly kind: FailureKind;
  readonly status: number | null;
  readonly message: string;
  readonly now: number;
}): SyncFailure | null {
  const { prev, kind } = input;
  if (kind !== "deterministic") return prev ?? null;

  const attempts = (prev?.attempts ?? 0) + 1;
  return {
    seriesId: input.seriesId,
    attempts,
    blocked: attempts >= MAX_PUSH_ATTEMPTS,
    status: input.status,
    message: input.message,
    at: input.now,
  };
}

// ─── Failure state (session-scoped, observable) ─────────────────────────────

const _failures = new Map<string, SyncFailure>();
type FailureListener = (failure: SyncFailure) => void;
const _failureListeners = new Set<FailureListener>();

/** Every series id we have already tried to auto-create a subscription for. */
const _trackAttempted = new Set<string>();

/** Current failure state for one series, or null when it is healthy. */
export function getSyncFailure(seriesId: string): SyncFailure | null {
  return _failures.get(seriesId) ?? null;
}

/** Snapshot of every series currently in a failed state. */
export function listSyncFailures(): SyncFailure[] {
  return [..._failures.values()];
}

/**
 * Subscribe to failure-state changes so the UI can say something.
 *
 * Fires on every deterministic failure, including the one that trips
 * `blocked`. Since a blocked series is never pushed again, the listener sees
 * `blocked: true` exactly once per series per session — which is what makes a
 * one-shot toast possible without any extra bookkeeping at the call site.
 */
export function onSyncFailure(listener: FailureListener): () => void {
  _failureListeners.add(listener);
  return () => {
    _failureListeners.delete(listener);
  };
}

function emitFailure(failure: SyncFailure): void {
  for (const listener of [..._failureListeners]) {
    try {
      listener(failure);
    } catch {
      // A broken banner must not fail the sync that already ran.
    }
  }
}

/** Test seam. Also the right thing to call if a rebind ever needs a reset. */
export function resetWatchSyncState(): void {
  _failures.clear();
  _trackAttempted.clear();
}

function recordFailure(
  seriesId: string,
  status: number | null,
  message: string,
  now: number,
): void {
  const kind = classifyPushFailure(status);
  const next = applyFailure({
    prev: _failures.get(seriesId),
    seriesId,
    kind,
    status,
    message,
    now,
  });
  if (!next) return;
  _failures.set(seriesId, next);
  emitFailure(next);
}

function clearFailure(seriesId: string): void {
  _failures.delete(seriesId);
}

// ─── Transport ──────────────────────────────────────────────────────────────

export interface PushOk {
  readonly ok: true;
  readonly status: number;
}
export interface PushErr {
  readonly ok: false;
  readonly status: number | null;
  readonly message: string;
}
export type PushResponse = PushOk | PushErr;

/** See `isPushPlanned` — same `strict: false` narrowing caveat. */
export function isPushErr(res: PushResponse): res is PushErr {
  return res.ok === false;
}

export interface SubscriptionSyncApi {
  /** PATCH the watch progress. MUST send `monotonic: true`. */
  patchProgress(anilistId: number, currentEpisode: number): Promise<PushResponse>;
  /** POST an idempotent `watching` subscription. MUST send `ifAbsent: true`. */
  createIfAbsent(anilistId: number): Promise<PushResponse>;
  /** Cheap "is anyone logged in" probe, so anonymous visits skip the 401. */
  isSignedIn(): boolean;
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } } | null;
    return body?.error?.message || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

async function send(
  path: string,
  method: "POST" | "PATCH",
  body: unknown,
): Promise<PushResponse> {
  try {
    // `skipRedirectOnFailure` matters more than it looks: authFetch's default
    // is to navigate to /login when a refresh fails, and this runs from a
    // background reconciler — a stale cookie would yank the user out of a
    // playing episode. A 401 here is data, not a UI event.
    const res = await authFetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      skipRedirectOnFailure: true,
    });
    if (res.ok) return { ok: true, status: res.status };
    return { ok: false, status: res.status, message: await readErrorMessage(res) };
  } catch (err) {
    return {
      ok: false,
      status: null,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** The production transport. Swapped out wholesale in tests. */
export const defaultSyncApi: SubscriptionSyncApi = {
  patchProgress(anilistId, currentEpisode) {
    return send(`/api/subscriptions/${anilistId}`, "PATCH", {
      currentEpisode,
      // Decision 8: the no-rollback guard lives in the server's GREATEST, and
      // this flag is what selects it. Without it a stale tab pushing episode 5
      // would claw a phone's episode 12 back down (mihon#1793).
      monotonic: true,
    });
  },
  createIfAbsent(anilistId) {
    return send("/api/subscriptions", "POST", {
      anilistId,
      status: "watching",
      // Decision 3: without this the server's ON CONFLICT DO UPDATE SET status
      // silently resurrects a subscription the user set to dropped/completed.
      ifAbsent: true,
    });
  },
  isSignedIn: hasAuthHint,
};

// ─── Dexie access (structural) ──────────────────────────────────────────────

interface RowsBySeriesId<T> {
  where(index: string): { anyOf(values: readonly string[]): { toArray(): Promise<T[]> } };
}

export interface WatchSyncDb {
  series: {
    get(id: string): Promise<WatchSyncSeries | undefined>;
    update(id: string, changes: Record<string, unknown>): Promise<unknown>;
  };
  episodes: RowsBySeriesId<WatchSyncEpisode>;
  progress: RowsBySeriesId<WatchSyncProgress>;
  /** Absent on a pre-v5 database — treated as "nothing was ever merged". */
  userOverride?: { toArray(): Promise<WatchSyncOverride[]> } | null;
}

/**
 * `WatchSyncDb` plus the two `userOverride` methods `animeBinding.readBinding`
 * reaches for.
 *
 * Spelled out rather than cast through `unknown`: this module resolves the
 * merge root by scanning the whole override table and then hands the same
 * handle to `readBinding`, which does a point lookup on it. A cast would let a
 * fake satisfy the compiler and then throw "get is not a function" at runtime —
 * which is precisely what it did the first time.
 */
export interface TrackingDb extends Omit<WatchSyncDb, "userOverride"> {
  userOverride?: {
    toArray(): Promise<WatchSyncOverride[]>;
    get(id: string): Promise<{ locked?: boolean } | undefined>;
    put(row: Record<string, unknown>): Promise<unknown>;
  } | null;
}

// ─── Reconciliation ─────────────────────────────────────────────────────────

export type SyncOutcome =
  | "pushed"
  | "signed-out"
  | "rejected"
  | "deferred"
  | PushSkipReason;

export interface SyncResult {
  /** The ROOT series id — the only one that owns a binding. */
  readonly seriesId: string;
  readonly outcome: SyncOutcome;
  readonly episode: number | null;
  readonly anilistId: number | null;
}

export interface SyncOptions {
  readonly api?: SubscriptionSyncApi;
  readonly now?: () => number;
  /**
   * Last-resort binding lookup, called only when a series has no
   * `Series.anilistId` yet. Returns the id it resolved, or null.
   *
   * Injected rather than imported: resolving means a title search against
   * `/api/dandanplay/search`, which lives in the app layer
   * (`app/library/_services/resolveSeriesBinding.ts`), and this module is not
   * allowed to depend on it. `makeBindingResolver` there is the adapter.
   *
   * PASS THIS AT EXACTLY TWO CALL SITES, both single-series and both started by
   * the user: the library card click (`startTracking`) and entering the player
   * (`reconcileSeries`, trigger 3). Do NOT pass it from the completion trigger
   * — by then the player entry has already resolved the same series — and
   * `reconcileLibrary` does not accept it at all, because a mount-time sweep of
   * a few hundred unbound series would become a few hundred simultaneous
   * searches for a page the user only wanted to look at. Unbound series are
   * skipped there and the card note explains why.
   */
  readonly resolveBinding?: (seriesId: string) => Promise<number | null>;
}

type EnsureOutcome = "created" | "already-attempted" | "failed";

/**
 * Create the subscription for a series, at most once per session.
 *
 * The bookkeeping rule is the interesting part. The "already handled" set is
 * marked on a success (nothing left to do) and on a deterministic refusal (a
 * repeat cannot produce a different answer — the title genuinely is not on
 * AniList), but NOT on a transient one. Latching a network blip would mean a
 * single offline card click disables subscription creation for the rest of the
 * session, including the 404 recovery inside `pushAndRecord`.
 */
async function ensureSubscription(
  rootId: string,
  anilistId: number,
  api: SubscriptionSyncApi,
): Promise<EnsureOutcome> {
  if (_trackAttempted.has(rootId)) return "already-attempted";

  const res = await api.createIfAbsent(anilistId);
  if (!isPushErr(res)) {
    _trackAttempted.add(rootId);
    return "created";
  }
  if (classifyPushFailure(res.status) === "deterministic") {
    _trackAttempted.add(rootId);
  }
  return "failed";
}

/**
 * Push one series' high-water mark, then persist it.
 *
 * `lastSyncedEpisode` is written only after the server accepts, which is the
 * whole no-queue design: a failure leaves the two numbers apart, and the next
 * trigger recomputes the identical push from state.
 */
async function pushAndRecord(
  db: WatchSyncDb,
  rootId: string,
  plan: PushPlanned,
  api: SubscriptionSyncApi,
  now: () => number,
): Promise<SyncResult> {
  const base = { seriesId: rootId, episode: plan.currentEpisode, anilistId: plan.anilistId };

  let res = await api.patchProgress(plan.anilistId, plan.currentEpisode);

  // A 404 from PATCH means one thing: this user has no subscription row for
  // this title. That is the state "click to start tracking" (T9) exists to
  // leave behind, and someone who just finished an episode has unambiguously
  // started watching — so create it once and retry, rather than burning the
  // attempt ceiling on a condition we can fix. `ifAbsent` keeps a hand-set
  // dropped/completed status intact, so this can never resurrect a status.
  if (isPushErr(res) && res.status === 404) {
    const ensured = await ensureSubscription(rootId, plan.anilistId, api);
    if (ensured === "created") {
      res = await api.patchProgress(plan.anilistId, plan.currentEpisode);
    }
  }

  if (!isPushErr(res)) {
    clearFailure(rootId);
    try {
      await db.series.update(rootId, { lastSyncedEpisode: plan.currentEpisode });
    } catch (err) {
      // The server already has the value. Failing to remember that costs one
      // redundant (and, thanks to `monotonic`, completely inert) PATCH next
      // time — not a reason to report the push as failed.
      // eslint-disable-next-line no-console
      console.warn("[watchSync] lastSyncedEpisode write failed:", err);
    }
    return { ...base, outcome: "pushed" };
  }

  recordFailure(rootId, res.status, res.message, now());
  const kind = classifyPushFailure(res.status);
  return { ...base, outcome: kind === "deterministic" ? "rejected" : "deferred" };
}

function skipped(rootId: string, reason: PushSkipReason, anilistId: number | null): SyncResult {
  return { seriesId: rootId, outcome: reason, episode: null, anilistId };
}

/**
 * Reconcile one series (trigger 1 and trigger 3).
 *
 * `seriesId` may be any member of a merged group; the root is resolved here, so
 * callers never have to know whether the card they are looking at is a merge.
 */
export async function reconcileSeries(
  db: WatchSyncDb,
  seriesId: string,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const api = opts.api ?? defaultSyncApi;
  const now = opts.now ?? Date.now;
  if (!seriesId) return skipped("", "unbound", null);

  const overrides = db.userOverride ? await db.userOverride.toArray() : [];
  const rootId = findRootSeriesId(overrides, seriesId);
  const groupIds = resolveGroupSeriesIds(overrides, rootId);

  const seriesRow = await db.series.get(rootId);
  const anilistId =
    toAnilistId(seriesRow?.anilistId) ??
    (opts.resolveBinding ? toAnilistId(await opts.resolveBinding(rootId)) : null);
  if (anilistId === null) return skipped(rootId, "unbound", null);

  const plan = decidePush({
    // `rootId` came out of findRootSeriesId, so this is true by construction.
    // Stated rather than implied: a caller handing a merged-in source id
    // straight to the pusher is exactly the bug this whole path prevents.
    isRoot: true,
    anilistId,
    lastSyncedEpisode: seriesRow?.lastSyncedEpisode,
    highWater: await readHighWater(db, groupIds),
    attempts: getSyncFailure(rootId)?.attempts ?? 0,
  });

  if (!isPushPlanned(plan)) return skipped(rootId, plan.reason, anilistId);
  if (!api.isSignedIn()) {
    return { seriesId: rootId, outcome: "signed-out", episode: plan.currentEpisode, anilistId: plan.anilistId };
  }
  return pushAndRecord(db, rootId, plan, api, now);
}

async function readHighWater(
  db: WatchSyncDb,
  groupIds: readonly string[],
): Promise<number | null> {
  if (!groupIds.length) return null;
  const [episodes, progress] = await Promise.all([
    db.episodes.where("seriesId").anyOf(groupIds).toArray(),
    db.progress.where("seriesId").anyOf(groupIds).toArray(),
  ]);
  return resolveHighWater(progress, episodes);
}

export interface LibraryReconcileInput {
  /**
   * Every progress row. On /library these are already in memory —
   * `useSeriesProgressMap` materialises `db.progress.toArray()` inside its
   * liveQuery and now hands the array out alongside the aggregate, so this
   * costs no extra progress query.
   */
  readonly progress: readonly WatchSyncProgress[];
  /** Series rows already loaded by `useLibrary` (merged-in sources excluded). */
  readonly series: readonly WatchSyncSeries[];
  /** `userOverride` rows already loaded by `useUserOverride`. */
  readonly overrides: readonly WatchSyncOverride[];
}

/**
 * Reconcile the whole library (trigger 2).
 *
 * Cost, stated honestly: zero extra PROGRESS queries and zero extra SERIES
 * queries — both are already in memory on /library — plus exactly ONE
 * `db.episodes` read, because `kind` is needed to keep NCOP/SP out of the
 * high-water mark and nothing on the library page reads `db.episodes` at all
 * (`useLibrary` reads `db.series`; `useResume` does point `bulkGet`s).
 *
 * That one read is narrowed to the series that could possibly push: bound,
 * root, and holding at least one completed row.
 *
 * Deliberately takes no `resolveBinding`, unlike the single-series paths. A
 * mature library can hold hundreds of unbound series, and resolving one means a
 * title search; doing that on mount would turn opening /library into a burst of
 * hundreds of simultaneous search requests. On-demand resolution stays where it
 * is bounded and the user asked for it — the card click and the player entry.
 */
export async function reconcileLibrary(
  db: WatchSyncDb,
  input: LibraryReconcileInput,
  opts: SyncOptions = {},
): Promise<SyncResult[]> {
  const api = opts.api ?? defaultSyncApi;
  const now = opts.now ?? Date.now;

  // root id → the completed progress rows anywhere in its merged group.
  const completedByRoot = new Map<string, WatchSyncProgress[]>();
  for (const row of input.progress) {
    if (row?.completed !== true) continue;
    if (typeof row.seriesId !== "string" || !row.seriesId) continue;
    const rootId = findRootSeriesId(input.overrides, row.seriesId);
    const bucket = completedByRoot.get(rootId);
    if (bucket) bucket.push(row);
    else completedByRoot.set(rootId, [row]);
  }
  if (completedByRoot.size === 0) return [];

  const seriesById = new Map<string, WatchSyncSeries>();
  for (const row of input.series) {
    if (row && typeof row.id === "string" && row.id) seriesById.set(row.id, row);
  }

  // Plan first, read second: only the series that survive `decidePush` need
  // their episodes, and `decidePush` needs nothing but numbers already in hand.
  // The high-water mark is not known yet, so pass a placeholder that cannot
  // short-circuit — the real value is checked in the second pass below.
  const candidates: string[] = [];
  const results: SyncResult[] = [];
  for (const rootId of completedByRoot.keys()) {
    const row = seriesById.get(rootId);
    const anilistId = toAnilistId(row?.anilistId);
    if (anilistId === null) {
      results.push(skipped(rootId, "unbound", null));
      continue;
    }
    if ((getSyncFailure(rootId)?.attempts ?? 0) >= MAX_PUSH_ATTEMPTS) {
      results.push(skipped(rootId, "blocked", anilistId));
      continue;
    }
    candidates.push(rootId);
  }
  if (candidates.length === 0) return results;

  const groupIds = new Set<string>();
  for (const rootId of candidates) {
    for (const id of resolveGroupSeriesIds(input.overrides, rootId)) groupIds.add(id);
  }
  const episodes = await db.episodes
    .where("seriesId")
    .anyOf([...groupIds])
    .toArray();

  const episodesByGroupMember = new Map<string, WatchSyncEpisode[]>();
  for (const ep of episodes) {
    const key = typeof ep?.seriesId === "string" ? ep.seriesId : "";
    if (!key) continue;
    const bucket = episodesByGroupMember.get(key);
    if (bucket) bucket.push(ep);
    else episodesByGroupMember.set(key, [ep]);
  }

  for (const rootId of candidates) {
    const row = seriesById.get(rootId);
    const groupEpisodes = resolveGroupSeriesIds(input.overrides, rootId).flatMap(
      (id) => episodesByGroupMember.get(id) ?? [],
    );
    const plan = decidePush({
      isRoot: true,
      anilistId: row?.anilistId,
      lastSyncedEpisode: row?.lastSyncedEpisode,
      highWater: resolveHighWater(completedByRoot.get(rootId) ?? [], groupEpisodes),
      attempts: getSyncFailure(rootId)?.attempts ?? 0,
    });
    if (!isPushPlanned(plan)) {
      results.push(skipped(rootId, plan.reason, toAnilistId(row?.anilistId)));
      continue;
    }
    if (!api.isSignedIn()) {
      results.push({
        seriesId: rootId,
        outcome: "signed-out",
        episode: plan.currentEpisode,
        anilistId: plan.anilistId,
      });
      continue;
    }
    // Sequential on purpose: a library-wide reconcile after a binge could
    // otherwise fire a dozen simultaneous PATCHes at a per-IP rate limiter.
    results.push(await pushAndRecord(db, rootId, plan, api, now));
  }
  return results;
}

// ─── T9: click a card, start tracking ───────────────────────────────────────

export type TrackOutcome =
  | "tracked"
  | "unbound"
  | "signed-out"
  | "already-attempted"
  | "failed";

export interface TrackResult {
  readonly seriesId: string;
  readonly outcome: TrackOutcome;
  readonly anilistId: number | null;
}

/**
 * Start tracking the show behind a library card (design doc decision 3).
 *
 * Server-side idempotent creation: `ifAbsent` means an existing row comes back
 * untouched, so a title the user set to `dropped` STAYS dropped and the client
 * never gets to overwrite a status. Status is human-only.
 *
 * Unbound series are not tracked and say so — the caller renders the reason on
 * the card. There is nothing to create a subscription FOR without an AniList
 * id, and guessing one from the title is how you subscribe someone to the
 * wrong show.
 */
export async function startTracking(
  db: TrackingDb,
  seriesId: string,
  opts: SyncOptions = {},
): Promise<TrackResult> {
  const api = opts.api ?? defaultSyncApi;
  if (!seriesId) return { seriesId: "", outcome: "unbound", anilistId: null };

  const overrides = db.userOverride ? await db.userOverride.toArray() : [];
  const rootId = findRootSeriesId(overrides, seriesId);

  // Through animeBinding, not `series.anilistId` directly — it is the one door
  // (decision 11), and it is the thing that knows a v5-shaped database has no
  // `userOverride` table to read a lock from.
  const binding = await readBinding(db, rootId);
  // Nothing bound yet is the NORMAL state for a freshly imported series: the
  // only automatic resolver used to be a hook on one route the grid never
  // visits. A card click is the user saying "track this", so resolve it now —
  // otherwise "import it, click it, it starts being tracked" cannot happen at
  // all. See SyncOptions.resolveBinding for why only two call sites may.
  const anilistId =
    binding?.anilistId ??
    (opts.resolveBinding ? toAnilistId(await opts.resolveBinding(rootId)) : null);
  if (anilistId === null) {
    return { seriesId: rootId, outcome: "unbound", anilistId: null };
  }
  if (!api.isSignedIn()) {
    return { seriesId: rootId, outcome: "signed-out", anilistId };
  }
  // One POST per series per session. The endpoint is idempotent, so a repeat
  // would be harmless — but a card click is a hot path and a no-op round trip
  // on every click is still a round trip.
  const ensured = await ensureSubscription(rootId, anilistId, api);
  return {
    seriesId: rootId,
    outcome: ensured === "created" ? "tracked" : ensured,
    anilistId,
  };
}

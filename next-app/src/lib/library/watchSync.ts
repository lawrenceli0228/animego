// Reconciles the local per-episode tick list against the server's per-episode
// watched set (`episode_watches`, migration 0024) and the integer it derives,
// `subscription.current_episode`.
//
// THE MODEL (design doc §4 decision 5): state is the truth, not a queue.
// Every push is derived from two SETS that both live in Dexie —
// `resolveWatchedEpisodes(progress, episodes)` and `series.lastSyncedEpisodes`
// — so replaying reconciliation any number of times is safe and an interrupted
// run leaves nothing to clean up. There is no outbox, no retry counter
// persisted anywhere, and there must not be one: Taiga's `history.xml` queue
// and Animeko's server-first mark-as-watched are both strictly worse (Taiga
// retries forever and never reads its own `retry_count`; Animeko drops offline
// marks on the floor). Do not add a queue here.
//
// Those two were single numbers until this change, and the difference is the
// whole point. A high-water mark can only say "the reader got to 9"; it cannot
// say "the reader watched 3, 5, 7, 8 and 9 and nothing else". Pushing the
// maximum left everything below it unmarked server-side, so one reader saw
// "5/14" on their library sheet and "1/14" on the same show's episode grid —
// the same fact, counted from two stores, disagreeing.
//
// THREE TRIGGERS (§3.1 / decision 14), all calling into this module:
//   the moment a `completed` row is written  → reconcileSeries(root of that series)
//   entering /library                        → reconcileLibrary(rows already in memory)
//   entering the player with a library series → reconcileSeries(that series)
//
// ─── CG2: telling the reader, and stopping the retries ──────────────────────
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
// That is TWO problems — a reader staring at progress that never moves, and a
// request loop with no exit — and they get two independent thresholds here,
// because the right number for each is different:
//
//   REPORT_AT_ATTEMPT (1)   the FIRST deterministic refusal is announced.
//   MAX_PUSH_ATTEMPTS (3)   after the third, the series stops being pushed.
//
// THEY USED TO BE ONE NUMBER, AND THAT WAS A BUG. `blocked` — reaching the
// retry ceiling — was also what the UI listened for, so the reader was only
// told on the third deterministic failure *of a single session*. The counter
// lives in a module-level Map (deliberately; see below) and therefore resets
// on every page load, so a normal viewing rhythm — watch an episode, close the
// tab, come back tomorrow — accrues one or two failures per session and never
// reaches three. Measured, not hypothetical: a reader's series failed every
// push with a deterministic 400 and they were never shown anything.
//
// Lowering the ceiling to 1 would have fixed the silence by breaking the
// retries. Reporting is free and wants to happen at once; retrying costs
// requests and wants a budget, because some 4xx clear on a re-plan —
// `pushAndRecord`'s 404 recovery is exactly that, and `ensureSubscription`
// can fail transiently inside it. So: two thresholds, and the reporting one
// does not depend on the counter surviving anything, since the first failure
// of every session qualifies. The reader hears about a broken series once per
// session for as long as it stays broken, which is the correct cadence for a
// fault that a reload cannot fix.
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
// Transient failures (offline, 5xx, rate limiting) are neither counted nor
// reported. Those are exactly the conditions decision 5 exists to ride out.
// 401 is neither, and is not a failure at all: the session expired, the user
// logs back in, and the next trigger pushes the same derived value (§8.1
// "401 过期→重登后补推").
//
// ─── What the sync memory is actually a claim ABOUT ─────────────────────────
//
// It is not "the episodes this user has watched". It is "the server accepted
// these episodes", and the server it accepted them FROM is a specific
// `subscriptions` row. Delete that row and the claim is void — migration 0024
// hangs `episode_watches` off a composite FK to (user_id, anilist_id), so
// unsubscribing takes every mark with it and re-subscribing starts a NEW row
// at zero. Local memory still said "synced to 5", `highWater` was still 5, and
// `5 <= 5` short-circuited before any request went out: the reconciler could
// not discover the reset because it never asked.
//
// So the memory carries the row's identity alongside the number.
// `subscriptions.created_at` is exactly that identity — it moves if and only
// if the row was deleted and re-inserted (`UpsertSubscription`'s ON CONFLICT
// touches `status` and `updated_at`, never `created_at`) — and it arrives on
// every row of `GET /api/subscriptions`, one request for the whole account.
//
// COMPARING THE NUMBER INSTEAD WOULD BE WRONG, and this is the part worth
// slowing down for. Since 0024 a PATCH does not overwrite `current_episode`;
// it INSERTs one `episode_watches` row and the column is re-derived as
// COALESCE(MAX(episode), 0) over the set. Two different events therefore make
// the server's number fall below ours:
//
//   the subscription was replaced   → re-push, that is this bug
//   the reader unmarked episode N   → do NOT re-push, they meant it
//
// A rule of "server is lower, so push" cannot tell them apart, and unmarking
// the top episode is the single most likely unmark there is. Identity can:
// unmarking leaves `created_at` alone. That asymmetry is the whole fix.
//
// AND THE SAME ASYMMETRY IS WHAT PROTECTS EVERY OTHER EPISODE, once the memory
// is a set rather than a maximum. The reconciler pushes `local \ pushed` and
// nothing else, so an episode this device has already pushed is never sent
// again — whatever the server currently holds, and without ever asking. Unmark
// episode 5 on the website and the reconciler leaves it alone, not because it
// noticed the unmark but because it has no new information about 5. The only
// thing that re-offers an already-pushed episode is the identity check above
// deciding the row it was pushed to no longer exists.
//
// No Dexie import and no `db` singleton import at module scope: `db.js` throws
// when loaded outside a browser, and every decision below has to stay reachable
// from a plain `bun test`.

import { hasAuthHint } from "@/lib/clientAuth";
import { authFetch } from "@/lib/authFetch";
// The episode-write response shape already has a parser, written for the
// detail page's grid, and it is the one that draws the distinction this module
// needs: `stated` separates "the server told us its set" from "the body did not
// carry one". A second copy here would be a second thing to keep in step with
// `episodeWatchResp`, and the two would drift the first time that struct gained
// a field. The module is pure — no React, no DOM — so it stays reachable from a
// plain `bun test`, which is the only import rule this file has.
import { parseWatchedSnapshot } from "@/components/anime/watchedEpisodeState";
import { readBinding } from "./animeBinding";
import { resolveWatchedEpisodes } from "./watchHighWater";

// ─── Row shapes (structural, so tests can hand in plain objects) ────────────

/** The `Series` fields this module reads. See `types.js`. */
export interface WatchSyncSeries {
  readonly id?: string;
  readonly anilistId?: number | null;
  /**
   * Every episode this device has pushed to the subscription identified by
   * `lastSyncedSubscribedAt`. THE authoritative sync memory; `readSyncedEpisodes`
   * is the only correct way to read it.
   *
   * Present-and-empty is a fact ("I have pushed nothing to THIS row") and is
   * not the same as absent, which means "written by a build that only kept a
   * maximum" — see `readSyncedEpisodes` for what that build's number is taken
   * to mean.
   */
  readonly lastSyncedEpisodes?: readonly number[] | null;
  /**
   * `max(lastSyncedEpisodes)`, or 0.
   *
   * DERIVED, not authoritative — the same relationship
   * `subscriptions.current_episode` has to `episode_watches` on the server,
   * mirrored here for the same reason: one stored fact, one number summarising
   * it, never two sources that can disagree. It is written on every push so a
   * build that predates the set (another tab, a rollback) still reads a true
   * number, and it is the migration input when the set is absent.
   */
  readonly lastSyncedEpisode?: number | null;
  /**
   * `subscriptions.created_at` of the row the memory was pushed to, as epoch
   * ms. Absent means "never observed", which is NOT the same as "unchanged" —
   * see `judgeSyncMemory`.
   */
  readonly lastSyncedSubscribedAt?: number | null;
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

/**
 * Deterministic pushes attempted per series, per session, before the series
 * stops being pushed at all.
 *
 * A RETRY CEILING AND NOTHING ELSE. It is not the point at which the reader is
 * told — that is `REPORT_AT_ATTEMPT`, and conflating the two is the bug the
 * header describes. Raising or lowering this number changes how many requests
 * a broken series is worth; it must not change what the reader sees.
 */
export const MAX_PUSH_ATTEMPTS = 3;

/**
 * Which deterministic failure is the one the reader hears about.
 *
 * One, because a deterministic failure is by definition reproducible: the
 * second and third attempts carry no information the first did not, and
 * waiting for them means waiting for a session long enough to contain three —
 * which a reader who watches one episode a night never has.
 *
 * Must stay `<= MAX_PUSH_ATTEMPTS`, or the attempt that reports would never be
 * reached and CG2 would be silent again.
 */
export const REPORT_AT_ATTEMPT = 1;

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
  /** The DELTA — episodes this device has not pushed yet, ascending. */
  readonly episodes: readonly number[];
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
 * The set of episodes this device has already pushed for one series.
 *
 * ─── The migration, and it is the whole of it ───────────────────────────────
 *
 * Rows written before this change carry a maximum and no set, and the number
 * they carry is read as `{1 .. N}`.
 *
 * That is not a guess about what the old code SENT — it sent one number. It is
 * a statement about what the server therefore HOLDS, and it is exact: the old
 * push wrote `current_episode = N`, and migration 0024's backfill turned every
 * such row into episode_watches rows `1 .. N` (`generate_series(1,
 * LEAST(current_episode, 5000))` — the migration's own comment calls this
 * "asserting what the row has been claiming all along"). The memory is a claim
 * about the server's state, so the migration that produced that state is
 * exactly the right thing to read the old number through.
 *
 * WHAT AN UPGRADING READER EXPERIENCES: nothing. Their first pass on the new
 * build finds `local \ {1..N}` empty for every series whose local episodes all
 * sit at or below the mark they already synced, so it issues no writes at all
 * — one account-wide GET for the whole library, exactly as before. From then
 * on the memory is a real set, built from real pushes, and every episode they
 * finish syncs individually.
 *
 * The alternative readings were both worse, in opposite directions:
 *
 *   `{}`   treat the old number as nothing. Every reader's whole library is
 *          re-pushed on the first mount after the upgrade, and — worse — every
 *          episode they had deliberately unchecked comes back, because an
 *          empty memory has no way to know they ever pushed it.
 *   `{N}`  treat it as literally the one number sent. Nearly as loud (one bulk
 *          write per series, missing one episode each) and it resurrects
 *          unmarks below N for the same reason.
 *
 * The residue of `{1..N}` is the mirror image: an episode below the old mark
 * that the server genuinely lacks is never offered again. For that to happen
 * the row must have been pushed AFTER 0024 and before this change — a window
 * that exists only on a machine that ran this branch, since 0024 has never
 * shipped. A reader cannot be in it. And it is not a trap even so: replacing
 * the subscription clears the memory, and the reader's next episode syncs
 * normally regardless.
 *
 * Presence beats content: a stored empty array means "pushed nothing to THIS
 * row" and must not fall through to the number beside it, or clearing the
 * memory on a replaced subscription would immediately un-clear itself.
 */
export function readSyncedEpisodes(row: WatchSyncSeries | null | undefined): Set<number> {
  const stored = row?.lastSyncedEpisodes;
  if (Array.isArray(stored)) {
    const out = new Set<number>();
    for (const n of stored) {
      if (typeof n === "number" && Number.isInteger(n) && n > 0) out.add(n);
    }
    return out;
  }

  const highWater = toSyncedEpisode(row?.lastSyncedEpisode);
  const out = new Set<number>();
  for (let n = 1; n <= highWater; n += 1) out.add(n);
  return out;
}

/**
 * An instant, from either an epoch-ms number (what we store) or an RFC 3339
 * string (what go-api sends). `null` means "no usable instant", which every
 * reader below treats as "unknown", never as "the epoch".
 */
function toTimestamp(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The whole push policy, as one pure function: push the difference between
 * what the library knows and what this device has already sent.
 *
 * `already-synced` now means "the difference is empty", which subsumes the old
 * "the server is at or past our maximum" and is strictly stronger — a set can
 * be behind at episode 5 while agreeing at episode 9, and the old comparison
 * could not see that at all.
 *
 * Note what is NOT here: an upper bound, and no cap on the delta either.
 *
 * Decision 4 puts the bound on the server, which holds the authoritative
 * `anime_cache.episodes`; the client's `Series.totalEpisodes` is optional and
 * often wrong, so bounding against it would silently drop legitimate progress.
 * Filtering an out-of-range episode out here would be worse than pointless: a
 * local episode numbered 6000 is evidence of a bad binding or a bad filename
 * parse, and the server's 400 is how that becomes visible — reported on the
 * first refusal, then retried up to the attempt ceiling and dropped. Filtering
 * it quietly would leave a broken series looking healthy forever.
 *
 * The delta is likewise sent whole. It cannot exceed the server's array cap
 * without more than five thousand completed main episodes in one merged
 * group, which is a mis-merge rather than a library — and a mis-merge is
 * exactly the thing the resulting 400, the report and the attempt ceiling
 * exist to surface, not to paper over with chunking nobody could exercise.
 */
export function decidePush(input: {
  readonly isRoot: boolean;
  readonly anilistId: unknown;
  /** What this device has already pushed — see `readSyncedEpisodes`. */
  readonly synced: ReadonlySet<number>;
  /** Locally-completed main episodes, ascending. */
  readonly watched: readonly number[];
  readonly attempts: number;
}): PushPlan {
  // First, because a merged-in source can carry a stale binding of its own and
  // pushing it would write another show's progress.
  if (!input.isRoot) return { push: false, reason: "not-root" };

  const anilistId = toAnilistId(input.anilistId);
  if (anilistId === null) return { push: false, reason: "unbound" };

  const watched = input.watched ?? [];
  if (watched.length === 0) return { push: false, reason: "nothing-watched" };

  const episodes = watched.filter((n) => !input.synced.has(n));
  if (episodes.length === 0) return { push: false, reason: "already-synced" };

  if (input.attempts >= MAX_PUSH_ATTEMPTS) {
    return { push: false, reason: "blocked" };
  }
  return { push: true, anilistId, episodes };
}

// ─── Is the memory still about the row it was written for? ──────────────────

/**
 * One subscription as the server currently holds it.
 *
 * Deliberately three fields out of the ~24 `GET /api/subscriptions` returns:
 * this module has no business knowing about cover art, and a narrow shape
 * keeps the parser's tolerance honest.
 */
export interface ServerSubscription {
  readonly anilistId: number;
  /** `COALESCE(MAX(episode), 0)` over the server's watched set. */
  readonly currentEpisode: number;
  /** `subscriptions.created_at` as epoch ms — the row's identity. */
  readonly subscribedAt: number | null;
}

/**
 * Reduce a `GET /api/subscriptions` body into the fields this module reads.
 *
 * Tolerant in the same way and for the same reason as
 * `subscriptionSetState.subscribedIdsFromList`: the endpoint answers
 * `{data:[…]}`, but a bare array, a null envelope and a row with a junk
 * `anilistId` must each cost that one row rather than the whole snapshot. A
 * row that survives with `subscribedAt: null` still tells us nothing about
 * identity, and `judgeSyncMemory` treats it as unknown rather than as changed.
 */
export function parseServerSubscriptions(body: unknown): ServerSubscription[] {
  const rows = Array.isArray(body)
    ? body
    : body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)
      ? (body as { data: unknown[] }).data
      : [];

  const out: ServerSubscription[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const anilistId = toAnilistId((row as { anilistId?: unknown }).anilistId);
    if (anilistId === null) continue;
    out.push({
      anilistId,
      currentEpisode: toSyncedEpisode((row as { currentEpisode?: unknown }).currentEpisode),
      subscribedAt: toTimestamp((row as { subscribedAt?: unknown }).subscribedAt),
    });
  }
  return out;
}

/**
 * `intact`   the memory describes the live row; keep short-circuiting.
 * `replaced` the row it described is gone; the memory must be cleared.
 * `unknown`  nothing to compare against; record what we saw, decide nothing.
 */
export type MemoryVerdict = "intact" | "replaced" | "unknown";

/**
 * Does `lastSyncedEpisode` still describe the subscription in front of us?
 *
 * Every branch that is not `replaced` errs toward leaving the memory alone,
 * because the cost of the two mistakes is not symmetric. Failing to clear a
 * stale memory delays a push until the reader watches one more episode.
 * Clearing a live one re-PATCHes a high-water mark — which, since 0024, INSERTs
 * an `episode_watches` row and can therefore put back an episode the reader
 * deliberately unchecked. Only an outright identity change is allowed to push.
 *
 * The `currentEpisode` guard is not redundant with the identity check, and it
 * is stricter than "is the server behind us" for a reason spelled out at the
 * branch itself.
 */
export function judgeSyncMemory(input: {
  readonly lastSyncedEpisode?: unknown;
  readonly lastSyncedEpisodes?: readonly number[] | null;
  readonly lastSyncedSubscribedAt: unknown;
  readonly server: ServerSubscription | null | undefined;
}): MemoryVerdict {
  // Nothing was ever synced, so there is no claim to falsify. This also keeps
  // a never-synced series from acquiring an identity it has no use for.
  //
  // Asked of the SET rather than the number, via the one reader that knows
  // what an absent set means — a legacy row carrying a maximum has synced
  // something, and must be judged like any other.
  const memory = readSyncedEpisodes({
    lastSyncedEpisode: toSyncedEpisode(input.lastSyncedEpisode),
    lastSyncedEpisodes: input.lastSyncedEpisodes,
  });
  if (memory.size === 0) return "intact";

  const { server } = input;
  // Absent from the snapshot means the reader unsubscribed and has NOT come
  // back. Clearing the memory here would push, the push would 404, and
  // `pushAndRecord`'s 404 recovery would create the very subscription they
  // just deleted. Leave it: there is nothing to heal until a row exists again.
  if (!server || server.subscribedAt === null) return "unknown";

  const recorded = toTimestamp(input.lastSyncedSubscribedAt);
  // Synced by a build that did not record identities yet. The observed value
  // becomes the baseline; the NEXT replacement is the one we can prove.
  if (recorded === null) return "unknown";

  if (recorded === server.subscribedAt) return "intact";

  // The identity is unfamiliar, so this is not the row the memory was written
  // for. Only an EMPTY row may be re-pushed, and "behind us" is not the test.
  //
  // A re-created subscription always starts at exactly zero — `episode_watches`
  // cascaded away with the row it hung off, and `current_episode` is MAX over
  // that set. So anything above zero means somebody already wrote to the NEW
  // row, and two histories produce the identical reading:
  //
  //   another device pushed 3 of our 5 and has not caught up yet
  //   the new row reached 5 and the reader then unchecked back down to 3
  //
  // Nothing observable separates them, and the second must not be overwritten.
  // So an unfamiliar row carrying any progress is `unknown`: adopt the
  // identity, push nothing, and let the high-water mark move progress the
  // ordinary way once the reader watches something. Same asymmetry as above —
  // a delayed push costs a reader nothing, a re-marked episode costs them the
  // one thing they explicitly asked for.
  if (server.currentEpisode !== 0) return "unknown";
  return "replaced";
}

export type FailureKind = "deterministic" | "transient" | "auth";

/**
 * Does this failure mean "stop trying" or "try again later"?
 *
 * Only a deterministic 4xx accrues, and this is the ONE gate in front of both
 * thresholds — a kind that is not `deterministic` neither counts toward the
 * ceiling nor reports, because `applyFailure` returns before either is
 * computed. That matters more now that reporting happens on attempt 1: a
 * mis-classified transient would not merely shorten a budget, it would put an
 * error in front of a reader whose only problem was a flaky connection.
 *
 * 401 is its own bucket because the fix is a login, not a retry budget, and
 * 408/425/429 are 4xx by number but transient by meaning — go-api answers 429
 * from its rate limiter, and spending either threshold on that would accuse a
 * user who did nothing wrong.
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
  /** Deterministic refusals since this series was last healthy. */
  readonly attempts: number;
  /**
   * THE SIGNAL THE UI ACTS ON: this refusal is the one the reader should be
   * told about, and no later refusal of the same run will be.
   *
   * True on attempt `REPORT_AT_ATTEMPT` and false on every other, so it is a
   * one-shot per series per run of failures — which is what lets a listener
   * toast unconditionally without any bookkeeping of its own. `recordFailure`
   * emits on exactly this flag, so a listener never even sees a `false` one;
   * the field is still stated rather than implied, because a consumer reading
   * `getSyncFailure` has no emission to infer it from.
   *
   * Deliberately NOT `blocked`. See the header: a reader whose sessions are
   * one episode long never reaches the ceiling, so gating the UI on it meant
   * gating it on nothing.
   */
  readonly reportable: boolean;
  /**
   * Retry ceiling reached — nothing else will be pushed this session.
   *
   * A statement about requests, not about the reader. By the time this turns
   * true they have already been told (see `reportable`); this is what
   * `decidePush` and `reconcileLibrary` read to stop asking the server.
   */
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
 * `null` — so a week offline can neither exhaust the budget nor raise a
 * report.
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
    // `===`, not `>=`: the flag has to be false again on attempts 2 and 3 or
    // the emitter would fire on each of them. A run that is cleared by a
    // success starts over at 1 and is reported again, which is right — it is
    // a new fault, not the same one repeating.
    reportable: attempts === REPORT_AT_ATTEMPT,
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

/**
 * The account's subscriptions as of THIS reconcile pass, plus the request
 * currently reading them and whether that read already failed.
 *
 * In memory for the same reason the attempt counter above is: a Dexie table
 * would mean a migration, a second source of truth, and a stale row to
 * explain. It is a cache of somebody else's state.
 *
 * SCOPED TO ONE PASS, not to the session, and the difference is the whole
 * reported bug. "Unsubscribe on the detail page, then re-subscribe" is
 * something a reader does in one sitting without ever reloading the tab; a
 * session-long cache would still be holding the pre-unsubscribe answer when
 * they walked back to /library, and the progress would not come back until
 * they happened to reload. One pass is the longest a snapshot can be trusted.
 *
 * Within a pass both flags are load-bearing: `_snapshot` keeps a library of
 * three hundred series to one request, and `_snapshotUnreadable` keeps an
 * offline one to one request rather than three hundred failures.
 */
let _snapshot: Map<number, ServerSubscription> | null = null;
let _snapshotPending: Promise<Map<number, ServerSubscription> | null> | null = null;
let _snapshotUnreadable = false;

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
 * Fires on the FIRST deterministic failure of a series and on no other: every
 * event carries `reportable: true`, and a series already reported stays quiet
 * until a success clears it. So a listener can toast unconditionally, exactly
 * once per broken series per session, with no bookkeeping at the call site.
 *
 * It fired on every deterministic failure until this change, and the UI gated
 * on `blocked` to get its one-shot. That threshold is unreachable in a normal
 * session — see the header — so the one shot was never fired at all. The
 * de-duplication belongs here, where the previous attempt is known, rather
 * than in each consumer.
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
  _snapshot = null;
  _snapshotPending = null;
  _snapshotUnreadable = false;
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
  // Attempts past the first still update the stored entry — `attempts`,
  // `blocked`, the latest status and message all move — but say nothing. The
  // reader was told on attempt 1 and a repeat of a deterministic refusal is
  // not news; re-emitting would put the same toast on screen three times.
  if (next.reportable) emitFailure(next);
}

function clearFailure(seriesId: string): void {
  _failures.delete(seriesId);
}

// ─── Transport ──────────────────────────────────────────────────────────────

export interface PushOk {
  readonly ok: true;
  readonly status: number;
  /**
   * The FULL post-write watched set the server says it now holds for this
   * anime, ascending — or `null` when the response did not state one.
   *
   * `MarkEpisodesWatched` re-derives `current_episode` as `COALESCE(MAX(episode),
   * 0)` over `episode_watches` inside the same statement and returns both, so
   * this is what actually landed rather than what we hoped would. The bytes
   * cross the wire either way; throwing them away bought nothing.
   *
   * `null`, not `[]`, for a body that said nothing — an older server, a proxy
   * that stripped it, a 204. The difference matters: `[]` is the server
   * claiming it holds nothing, which after a successful mark is a real
   * anomaly, while `null` is the absence of a claim and must stay silent. Same
   * `stated`-vs-empty distinction the detail page's grid draws before it
   * repaints a reader's checkmarks.
   *
   * Optional because `createIfAbsent` goes through the same transport and
   * answers with a subscription row, which carries no set at all.
   */
  readonly stored?: readonly number[] | null;
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

/**
 * The watched set a `2xx` body states, or `null` when it states none.
 *
 * Split from the `Response` it came out of so the tolerance is testable
 * without a fake `fetch`: everything below the JSON parse is a pure decision
 * about a shape somebody else controls.
 */
export function storedEpisodesFromBody(body: unknown): readonly number[] | null {
  const snapshot = parseWatchedSnapshot(body);
  return snapshot.stated ? snapshot.watchedEpisodes : null;
}

/**
 * Which of the episodes we just sent the server did NOT report back as stored.
 *
 * CONTAINMENT, NOT EQUALITY, and that is the whole subtlety. The statement
 * `INSERT … ON CONFLICT DO NOTHING`s into `episode_watches` and then returns
 * the union of everything in the row, so the answer is a SUPERSET of the delta
 * whenever another device — a phone, the detail page's grid — has marked
 * something this one has never heard of. That is the normal case, not a fault:
 * an equality check would fire on every reader who owns two devices.
 *
 * Duplicates in the request are a non-issue for the same reason. `parseEpisodeList`
 * accepts them and `ON CONFLICT DO NOTHING` collapses them, so a body naming
 * `[3, 3, 4]` stores two rows for three members — a count comparison would
 * accuse a request that was answered perfectly. Membership does not care, and
 * building the answer through a `Set` means a later rewrite cannot quietly turn
 * this back into a count.
 *
 * `null`/`undefined` — no set was stated — is not evidence of anything and
 * answers empty.
 */
export function findUnstoredEpisodes(
  sent: readonly number[],
  stored: readonly number[] | null | undefined,
): number[] {
  if (!stored) return [];
  const held = new Set(stored);
  const missing = new Set<number>();
  for (const episode of sent ?? []) {
    if (!held.has(episode)) missing.add(episode);
  }
  return [...missing].sort((a, b) => a - b);
}

export interface SubscriptionSyncApi {
  /**
   * PUT a SET of episodes as watched, in ONE request.
   *
   * The server unions; it never replaces. That is what makes this safe to
   * call from a device that only knows part of the picture — the marks
   * another device made are not this one's to delete.
   */
  markEpisodes(anilistId: number, episodes: readonly number[]): Promise<PushResponse>;
  /** POST an idempotent `watching` subscription. MUST send `ifAbsent: true`. */
  createIfAbsent(anilistId: number): Promise<PushResponse>;
  /**
   * Every subscription this account holds, in ONE request.
   *
   * `null` means "could not read" — offline, 401, 5xx — and is not the same
   * as an empty array. An empty array is a signed-in reader with nothing
   * subscribed, which is a fact; `null` is the absence of one, and nothing
   * downstream may act on it.
   */
  listSubscriptions(): Promise<ServerSubscription[] | null>;
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

/**
 * The stored set off a successful response, or `null` if it did not carry one.
 *
 * A body that will not parse is `null` and NOT a failure: the write already
 * returned 2xx, and an unreadable body says nothing about whether the episodes
 * landed. Degrading here is what keeps an older server, a 204, or a proxy that
 * strips bodies behaving exactly as they did before this check existed.
 */
async function readStoredEpisodes(res: Response): Promise<readonly number[] | null> {
  try {
    return storedEpisodesFromBody((await res.json()) as unknown);
  } catch {
    return null;
  }
}

async function send(
  path: string,
  method: "POST" | "PUT",
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
    if (res.ok) return { ok: true, status: res.status, stored: await readStoredEpisodes(res) };
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
  markEpisodes(anilistId, episodes) {
    // ONE request for the whole set, which is the reason this route exists:
    // a first sync of a two-cour series is fifty episodes, and fifty requests
    // behind one /library mount would be answered by a per-IP rate limiter
    // rather than by the database.
    //
    // No `monotonic` flag, and none is needed. Decision 8's no-rollback
    // guarantee used to depend on every caller remembering to send it; since
    // 0024 the value is `MAX` over a set this write can only add to, so a
    // stale tab pushing episode 5 cannot claw a phone's episode 12 back down
    // (mihon#1793) whatever it sends.
    return send(`/api/subscriptions/${anilistId}/episodes`, "PUT", { episodes });
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
  async listSubscriptions() {
    try {
      // `skipRedirectOnFailure` for the same reason `send` uses it: this runs
      // from a background reconciler and a 401 here is data, not a reason to
      // yank the reader out of a playing episode.
      const res = await authFetch("/api/subscriptions", { skipRedirectOnFailure: true });
      if (!res.ok) return null;
      return parseServerSubscriptions((await res.json()) as unknown);
    } catch {
      return null;
    }
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
  /**
   * The episodes this pass offered the server, ascending — the delta, not the
   * library's whole set. Empty for every non-pushing outcome.
   */
  readonly episodes: readonly number[];
  /**
   * `max(episodes)`, or null. The number a message to the reader would use,
   * kept beside the set for the same reason the server keeps
   * `current_episode` beside `episode_watches`.
   */
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
   * `reconcileLibrary` does not accept it at all, because threading a resolver
   * through a pass that walks the whole library is how one mount becomes a few
   * hundred simultaneous searches. Unbound series are skipped there.
   *
   * That is a restriction on THIS seam, not a statement that unbound series go
   * unresolved. They are resolved on mount now, by
   * `app/library/_services/bindUnboundSeries.ts`, which calls
   * `resolveSeriesBinding` directly and carries the bound this option has no way
   * to express: capped per mount, one search at a time, spaced, abortable. The
   * sweep runs BESIDE `reconcileLibrary` rather than inside it, which is exactly
   * what lets this parameter stay as narrow as it is.
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
 * The account's subscriptions: exactly one read per reconcile pass, success or
 * failure, however many series that pass walks.
 *
 * A failure does not latch beyond the pass, for the reason `ensureSubscription`
 * gives about transient refusals: one offline moment must not disable a repair
 * path. It does latch WITHIN the pass, or an offline `reconcileLibrary` over
 * three hundred series would issue three hundred sequential failing requests —
 * the same shape as the mount-time search burst `reconcileLibrary` refuses to
 * become.
 */
async function loadSubscriptionSnapshot(
  api: SubscriptionSyncApi,
): Promise<Map<number, ServerSubscription> | null> {
  if (_snapshot) return _snapshot;
  if (_snapshotUnreadable) return null;

  const inFlight = _snapshotPending ?? (_snapshotPending = fetchSubscriptionSnapshot(api));
  const result = await inFlight;
  // `_snapshotPending` means "a read is in flight" and nothing more. Retiring
  // it on settle is what lets the next pass ask again instead of awaiting the
  // last pass's already-resolved answer. Guarded so an overlapping pass that
  // started its own read does not have its slot cleared by this one.
  if (_snapshotPending === inFlight) _snapshotPending = null;
  if (result === null) _snapshotUnreadable = true;
  return result;
}

/**
 * Open a reconcile pass: forget the previous pass's answer.
 *
 * `_snapshotPending` is deliberately NOT cleared. An overlapping pass — a
 * completed episode landing while the player's entry reconcile is still
 * running — should share the read that is already on the wire rather than
 * start a second one; it is milliseconds old, not a pass old.
 */
function beginReconcilePass(): void {
  _snapshot = null;
  _snapshotUnreadable = false;
}

async function fetchSubscriptionSnapshot(
  api: SubscriptionSyncApi,
): Promise<Map<number, ServerSubscription> | null> {
  let rows: ServerSubscription[] | null = null;
  try {
    rows = await api.listSubscriptions();
  } catch {
    // A transport that throws rather than answering is the offline case, and
    // it must read as "no snapshot", never as "you have no subscriptions".
    return null;
  }
  if (rows === null) return null;
  const byAnilistId = new Map<number, ServerSubscription>();
  for (const row of rows) byAnilistId.set(row.anilistId, row);
  _snapshot = byAnilistId;
  return byAnilistId;
}

/**
 * Give a plan that stopped at `already-synced` one chance to be wrong.
 *
 * Returns `true` when the memory turned out to describe a subscription that no
 * longer exists, in which case it has been cleared and the caller must re-plan.
 *
 * The Dexie writes are both caches of the server's state, so a failed write
 * costs one more revalidation next pass and nothing else — it cannot lose a
 * reader's progress, and it cannot leave the two fields describing different
 * rows, because the clearing write sets them together or not at all.
 */
async function revalidateSyncMemory(
  db: WatchSyncDb,
  rootId: string,
  anilistId: number,
  seriesRow: WatchSyncSeries | undefined,
  api: SubscriptionSyncApi,
): Promise<boolean> {
  // Before the network, not after: an anonymous visitor has no subscriptions
  // to compare against and must not be made to ask.
  if (!api.isSignedIn()) return false;

  const snapshot = await loadSubscriptionSnapshot(api);
  if (!snapshot) return false;

  const server = snapshot.get(anilistId) ?? null;
  const verdict = judgeSyncMemory({
    lastSyncedEpisode: seriesRow?.lastSyncedEpisode,
    lastSyncedEpisodes: seriesRow?.lastSyncedEpisodes,
    lastSyncedSubscribedAt: seriesRow?.lastSyncedSubscribedAt,
    server,
  });
  if (verdict === "intact") return false;

  if (verdict === "unknown") {
    // Adopt the identity we just saw so the next replacement is provable.
    // Nothing else changes — this is bookkeeping, not a decision.
    if (server?.subscribedAt != null) {
      await writeSeries(db, rootId, { lastSyncedSubscribedAt: server.subscribedAt });
    }
    return false;
  }

  // Every field in ONE write, so a reload can never find the memory
  // describing one subscription and the identity describing another.
  // `replaced` implies judgeSyncMemory saw a snapshot row carrying a usable
  // identity, so the second value is the new row's; the `?? null` is there
  // for the reader, not for a case that can occur.
  //
  // This is where the whole memory is cleared, and it is the ONLY place —
  // which is what makes "a re-subscribe re-pushes everything, an unmark
  // re-pushes nothing" one rule rather than two. The set generalises the
  // number it replaced; it did not add a second thing to invalidate.
  await writeSeries(db, rootId, {
    // An EMPTY ARRAY, not a missing field: `readSyncedEpisodes` reads a
    // present-but-empty set as "pushed nothing to THIS row" and an absent one
    // as a legacy maximum to expand. Deleting the field here would hand the
    // cleared memory straight back to the migration path.
    lastSyncedEpisodes: [],
    // The derived mirror, kept in step in the same write for the same reason
    // the server recomputes current_episode inside its own statement.
    lastSyncedEpisode: 0,
    lastSyncedSubscribedAt: server?.subscribedAt ?? null,
  });
  return true;
}

/** `db.series.update`, minus the right to fail the whole reconcile. */
async function writeSeries(
  db: WatchSyncDb,
  rootId: string,
  changes: Record<string, unknown>,
): Promise<void> {
  try {
    await db.series.update(rootId, changes);
  } catch (err) {
    console.warn("[watchSync] series sync memory write failed:", err);
  }
}

/**
 * The invariant, checked against the answer we were already being sent:
 * WHAT THE SERVER STORED CONTAINS EVERYTHING WE JUST SENT.
 *
 * ─── The severity, and why it is this one ───────────────────────────────────
 *
 * A `console.warn` and nothing else. Not `recordFailure`, not a changed
 * outcome, not a withheld memory write — each of those was considered and each
 * is worse than the fault it would be reporting.
 *
 *   NOT `recordFailure`. It runs the status through `classifyPushFailure`, and
 *   there is no status to run: this is a 200. Forcing one in would either be
 *   classified `transient` — in which case `applyFailure` returns the previous
 *   entry and the whole thing is silent, i.e. no trace at all — or forced to
 *   `deterministic`, which spends one of `MAX_PUSH_ATTEMPTS` and, since
 *   `REPORT_AT_ATTEMPT` is 1, puts "this series is not syncing" in front of the
 *   reader on the very first mismatch. Both readings are wrong for the same
 *   reason: THE PUSH SUCCEEDED. The likeliest cause of a mismatch is not lost
 *   progress but a changed response shape — a version skew, a proxy, a field
 *   rename — and blocking a series that is in fact syncing perfectly, or
 *   telling its owner it is broken, costs strictly more than the mismatch does.
 *
 *   NOT a non-`pushed` outcome. `rejected`/`deferred` mean "the server does not
 *   have these episodes", and callers re-plan on them. Saying that about a
 *   write that returned 200 invites exactly the unbounded retry the header
 *   forbids.
 *
 *   NOT withholding the memory write. That would re-derive the identical delta
 *   on all three triggers forever — same unbounded loop — and, worse, would
 *   re-offer episodes the reader has since deliberately unchecked, which is the
 *   one thing the memory exists to prevent.
 *
 * So: the module's existing developer channel (`writeSeries` and the memory
 * write below already use it), zero effect on control flow, and it carries both
 * sets so whoever reads it can tell "the server stopped stating its set the way
 * it used to" from "episode 7 genuinely did not land".
 */
function reportUnstoredEpisodes(
  rootId: string,
  anilistId: number,
  sent: readonly number[],
  stored: readonly number[] | null | undefined,
): void {
  const missing = findUnstoredEpisodes(sent, stored);
  if (missing.length === 0) return;
  console.warn(
    `[watchSync] server accepted the push for series ${rootId} (anilist ${anilistId}) ` +
      `but did not report ${missing.join(", ")} as stored`,
    { sent: [...new Set(sent)].sort((a, b) => a - b), stored: [...(stored ?? [])] },
  );
}

/**
 * Push one series' unsent episodes, then remember them.
 *
 * The memory is written only after the server accepts, which is the whole
 * no-queue design: a failure leaves the two sets apart, and the next trigger
 * recomputes the identical delta from state.
 *
 * It is written as the UNION of what was remembered and what was just sent,
 * not as a copy of the local set. The two differ whenever the local set
 * shrinks — a rescan that loses a file, a split that moves episodes onto
 * another series — and a memory that shrank with it would re-offer those
 * episodes the moment they came back, putting a reader's deliberate unmark
 * straight back on their screen. The memory only ever grows, and only
 * `revalidateSyncMemory` empties it.
 */
async function pushAndRecord(
  db: WatchSyncDb,
  rootId: string,
  plan: PushPlanned,
  synced: ReadonlySet<number>,
  api: SubscriptionSyncApi,
  now: () => number,
): Promise<SyncResult> {
  const episodes = [...plan.episodes];
  const base = {
    seriesId: rootId,
    // The maximum of what was sent, which is what the server's
    // current_episode will be at or above once it lands.
    episode: episodes[episodes.length - 1] ?? null,
    episodes,
    anilistId: plan.anilistId,
  };

  let res = await api.markEpisodes(plan.anilistId, episodes);

  // A 404 means one thing: this user has no subscription row for this title.
  // That is the state "click to start tracking" (T9) exists to leave behind,
  // and someone who just finished an episode has unambiguously started
  // watching — so create it once and retry, rather than recording a failure
  // for a condition we can fix. Recording one now costs more than an attempt:
  // since reporting moved to the first refusal, it would also tell the reader
  // their sync is broken a moment before it repairs itself. `ifAbsent` keeps a
  // hand-set dropped/completed status intact, so this can never resurrect one.
  if (isPushErr(res) && res.status === 404) {
    const ensured = await ensureSubscription(rootId, plan.anilistId, api);
    if (ensured === "created") {
      res = await api.markEpisodes(plan.anilistId, episodes);
    }
  }

  if (!isPushErr(res)) {
    clearFailure(rootId);
    reportUnstoredEpisodes(rootId, plan.anilistId, episodes, res.stored);
    // From what was SENT, never from what came back. `res.stored` is the whole
    // row — including episodes another device marked — and this field is not a
    // record of the row, it is a record of what THIS device pushed to it (see
    // `WatchSyncSeries.lastSyncedEpisodes`). Folding the server's set in would
    // make the memory claim credit for marks it never sent, and the next reader
    // of `local \ pushed` would silently stop offering them. The check above
    // adds an assertion; it does not add a source of truth.
    const remembered = [...new Set([...synced, ...episodes])].sort((a, b) => a - b);
    try {
      await db.series.update(rootId, {
        lastSyncedEpisodes: remembered,
        // Derived in the same write, never separately — see
        // `WatchSyncSeries.lastSyncedEpisode`.
        lastSyncedEpisode: remembered[remembered.length - 1] ?? 0,
      });
    } catch (err) {
      // The server already has the episodes, so failing to remember them is
      // not a reason to report the push as failed. It costs one redundant
      // request next time, and that request is harmless because every episode
      // in it is already in the server's set (ON CONFLICT DO NOTHING).
      //
      // Harmless BECAUSE it is already there — not because the write does
      // nothing. Re-sending an episode the reader has since unchecked would
      // put it back, and the only thing standing between this module and that
      // is the memory this line failed to write. So the next pass re-offering
      // the same delta is the price, and it is the right price: it is
      // bounded, it is idempotent while nothing has changed, and it beats
      // treating a Dexie hiccup as lost progress.
      console.warn("[watchSync] sync memory write failed:", err);
    }
    return { ...base, outcome: "pushed" };
  }

  recordFailure(rootId, res.status, res.message, now());
  const kind = classifyPushFailure(res.status);
  return { ...base, outcome: kind === "deterministic" ? "rejected" : "deferred" };
}

function skipped(rootId: string, reason: PushSkipReason, anilistId: number | null): SyncResult {
  return { seriesId: rootId, outcome: reason, episodes: [], episode: null, anilistId };
}

/**
 * `decidePush`, plus the one question it cannot answer out of local state: is
 * `lastSyncedEpisode` still a claim about a subscription that exists?
 *
 * ONLY `already-synced` is re-examined, and that is the whole scope of the
 * revalidation. Every other skip reason is a fact about local data — not the
 * root, not bound, nothing watched, out of attempts — and no server state
 * changes any of them. `already-synced` is the only verdict that rests on a
 * remembered claim about somebody else's row.
 *
 * The re-plan goes back through `decidePush` rather than pushing directly, so
 * a healed series is still subject to the attempt ceiling. A binding that
 * points at the wrong show does not get a fresh retry budget for having been
 * unsubscribed.
 */
async function planPush(
  db: WatchSyncDb,
  rootId: string,
  anilistId: number,
  seriesRow: WatchSyncSeries | undefined,
  input: { readonly watched: readonly number[]; readonly attempts: number },
  api: SubscriptionSyncApi,
): Promise<{ readonly plan: PushPlan; readonly synced: ReadonlySet<number> }> {
  const base = {
    isRoot: true,
    anilistId,
    watched: input.watched,
    attempts: input.attempts,
  };
  const synced = readSyncedEpisodes(seriesRow);
  const plan = decidePush({ ...base, synced });
  if (isPushPlanned(plan)) return { plan, synced };
  if (plan.reason !== "already-synced") return { plan, synced };

  const replaced = await revalidateSyncMemory(db, rootId, anilistId, seriesRow, api);
  if (!replaced) return { plan, synced };
  // The memory was cleared against a row that no longer exists, so the delta
  // is now the whole local set — which is exactly right for a subscription the
  // reader deleted and re-created.
  const empty: ReadonlySet<number> = new Set<number>();
  return { plan: decidePush({ ...base, synced: empty }), synced: empty };
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
  beginReconcilePass();

  const overrides = db.userOverride ? await db.userOverride.toArray() : [];
  const rootId = findRootSeriesId(overrides, seriesId);
  const groupIds = resolveGroupSeriesIds(overrides, rootId);

  const seriesRow = await db.series.get(rootId);
  const anilistId =
    toAnilistId(seriesRow?.anilistId) ??
    (opts.resolveBinding ? toAnilistId(await opts.resolveBinding(rootId)) : null);
  if (anilistId === null) return skipped(rootId, "unbound", null);

  // `isRoot: true` inside planPush is true by construction — `rootId` came out
  // of findRootSeriesId. Stated rather than implied: a caller handing a
  // merged-in source id straight to the pusher is exactly the bug this whole
  // path prevents.
  const { plan, synced } = await planPush(
    db,
    rootId,
    anilistId,
    seriesRow,
    {
      watched: await readWatchedEpisodes(db, groupIds),
      attempts: getSyncFailure(rootId)?.attempts ?? 0,
    },
    api,
  );

  if (!isPushPlanned(plan)) return skipped(rootId, plan.reason, anilistId);
  if (!api.isSignedIn()) {
    return {
      seriesId: rootId,
      outcome: "signed-out",
      episodes: plan.episodes,
      episode: plan.episodes[plan.episodes.length - 1] ?? null,
      anilistId: plan.anilistId,
    };
  }
  return pushAndRecord(db, rootId, plan, synced, api, now);
}

async function readWatchedEpisodes(
  db: WatchSyncDb,
  groupIds: readonly string[],
): Promise<number[]> {
  if (!groupIds.length) return [];
  const [episodes, progress] = await Promise.all([
    db.episodes.where("seriesId").anyOf(groupIds).toArray(),
    db.progress.where("seriesId").anyOf(groupIds).toArray(),
  ]);
  return resolveWatchedEpisodes(progress, episodes);
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
 * title search; threading a resolver through a pass that walks all of them would
 * turn opening /library into a burst of hundreds of simultaneous search
 * requests. An unbound series is skipped here and reported as `"unbound"`.
 *
 * Skipped by this function is no longer skipped by the system, though.
 * `library/_services/bindUnboundSeries.ts` sweeps the unbound ones on mount —
 * capped, sequential, spaced, abortable — calling `resolveSeriesBinding`
 * directly instead of through the seam above. It runs BESIDE this function, and
 * `LibraryShell` re-arms this function once the sweep reports it bound
 * something, so a series bound at second three of a mount is pushed in that same
 * mount rather than waiting for the reader's next visit.
 */
export async function reconcileLibrary(
  db: WatchSyncDb,
  input: LibraryReconcileInput,
  opts: SyncOptions = {},
): Promise<SyncResult[]> {
  const api = opts.api ?? defaultSyncApi;
  const now = opts.now ?? Date.now;
  beginReconcilePass();

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
  // Carries the resolved `anilistId` rather than re-deriving it below, so the
  // second pass cannot need a cast to assert what this pass already proved.
  const candidates: { rootId: string; anilistId: number }[] = [];
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
    candidates.push({ rootId, anilistId });
  }
  if (candidates.length === 0) return results;

  const groupIds = new Set<string>();
  for (const { rootId } of candidates) {
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

  for (const { rootId, anilistId } of candidates) {
    const row = seriesById.get(rootId);
    const groupEpisodes = resolveGroupSeriesIds(input.overrides, rootId).flatMap(
      (id) => episodesByGroupMember.get(id) ?? [],
    );
    // Revalidation inside costs at most ONE request for this entire loop: the
    // snapshot is account-wide and cached for the pass (see `_snapshot` — the
    // lifetime is ONE pass, deliberately, not the session), so three
    // hundred series asks once, not three hundred times. The memory that
    // decides whether to push at all is local, so the set generalisation adds
    // no read here either — per series, this loop still touches the network
    // only when it has something to write.
    const { plan, synced } = await planPush(
      db,
      rootId,
      anilistId,
      row,
      {
        watched: resolveWatchedEpisodes(completedByRoot.get(rootId) ?? [], groupEpisodes),
        attempts: getSyncFailure(rootId)?.attempts ?? 0,
      },
      api,
    );
    if (!isPushPlanned(plan)) {
      results.push(skipped(rootId, plan.reason, anilistId));
      continue;
    }
    if (!api.isSignedIn()) {
      results.push({
        seriesId: rootId,
        outcome: "signed-out",
        episodes: plan.episodes,
        episode: plan.episodes[plan.episodes.length - 1] ?? null,
        anilistId: plan.anilistId,
      });
      continue;
    }
    // Sequential on purpose: a library-wide reconcile after a binge could
    // otherwise fire a dozen simultaneous writes at a per-IP rate limiter.
    // One request per series that has something to say, and none from the
    // rest — the set does not change that shape, it only makes the one
    // request carry everything instead of just its maximum.
    results.push(await pushAndRecord(db, rootId, plan, synced, api, now));
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

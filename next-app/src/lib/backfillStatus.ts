// Pure derivations for the /admin "中文简介回填" block.
//
// The P3 sweep is a *perpetual* job: it wakes hourly, takes whatever is
// eligible and not yet done, and goes back to sleep. There is no final
// batch, so a processed/total progress bar would sit at a fake 100% the
// moment a cycle drains — which is precisely when a new anime row
// becoming eligible should have pushed it back down. The block therefore
// reports a *coverage* number plus two liveness signals, and every value
// below is derived here rather than inline in JSX so the arithmetic and
// the threshold judgements can be tested without a DOM stack.
//
// Wire source (go-api internal/admin):
//   stats.descriptionCn        -> { eligible, done, rejected, pending }
//   stats.queue.descriptionBackfill
//                              -> { queued, retrying, discarded,
//                                   lastScanAt, lastWriteAt }
//
// "eligible" is the row count of the description_cn_eligible view
// (migration 0016) — the single definition of "this row's bgm binding is
// trustworthy". Nothing here re-derives that predicate.

/** Queue counters, split by River state. Mirrors BackfillQueue on the wire. */
export interface BackfillQueueCounts {
  /** available + running + scheduled + pending — work that will be tried. */
  queued: number;
  /** retryable — tried, failed, waiting to be tried again. */
  retrying: number;
  /** retries exhausted; nobody will pick these up again. */
  discarded: number;
}

/** Coerces a wire number to a usable non-negative integer-ish value. */
function safeCount(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

// ---------------------------------------------------------------------------
// Catalogue split
// ---------------------------------------------------------------------------

/**
 * Rows that can never receive a Chinese synopsis: everything in
 * anime_cache that the eligible view rejects (no bgm_id, or a binding no
 * independent source confirms).
 *
 *   SELECT (SELECT count(*) FROM anime_cache)
 *        - (SELECT count(*) FROM description_cn_eligible);
 *
 * Worth showing next to coverage because the two denominators differ and
 * the difference is the honest one. Coverage is measured against
 * `eligible`, so a library whose bindings are mostly unconfirmed can read
 * 100% covered while most of its catalogue has no Chinese text at all.
 * This number is what stops that from being a misreading: 100% of 13 out
 * of 285 rows is a very different report from 100% of 285.
 *
 * Clamped at 0 — the eligible view is a subset of anime_cache, so a
 * negative result can only mean the two counts came from payloads taken
 * at different moments, and a negative "ineligible" is nonsense to render.
 */
export function ineligibleCount(animeTotal: number, eligible: number): number {
  const total = safeCount(animeTotal);
  const ok = safeCount(eligible);
  return Math.max(total - ok, 0);
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/**
 * Share of eligible rows that already carry a Chinese description, as a
 * plain 0–100 number (unrounded, so it stays byte-for-byte checkable
 * against SQL):
 *
 *   SELECT count(*) FILTER (WHERE description_cn IS NOT NULL) * 100.0
 *          / NULLIF(count(*), 0)
 *   FROM description_cn_eligible;
 *
 * Guards, each covering a real input the dashboard will see:
 *  - eligible = 0 returns 0, never NaN. A fresh or empty database has an
 *    empty eligible view, and `0/0` rendered straight into JSX prints
 *    "NaN%" across the whole block.
 *  - done is clamped into [0, eligible]. `done` and `eligible` come from
 *    two separate queries, so a row enriched between them can legitimately
 *    make done > eligible for one poll; that must read as 100, not 103.
 *  - non-finite input degrades to 0 rather than propagating NaN onward.
 *
 * Use {@link formatCoveragePct} for display — it carries the rounding
 * rules that keep "almost done" from printing as "done".
 */
export function coveragePct(done: number, eligible: number): number {
  if (!Number.isFinite(done) || !Number.isFinite(eligible)) return 0;
  if (eligible <= 0) return 0;
  const capped = Math.min(Math.max(done, 0), eligible);
  return (capped / eligible) * 100;
}

/**
 * Renders a coverage percentage to one decimal place, with two lies
 * suppressed:
 *  - 99.97 must not print as "100.0". This block exists to show the sweep
 *    still has work left; rounding the last few hundred rows away turns a
 *    live backlog into a finished one at a glance.
 *  - a non-zero coverage must not print as "0.0" for the mirror-image
 *    reason: "it has never written anything" and "it has written a few"
 *    are different operational states.
 *
 * Exact 0 and exact 100 pass through untouched — those are true.
 */
export function formatCoveragePct(pct: number): string {
  if (!Number.isFinite(pct) || pct <= 0) return "0.0";
  if (pct >= 100) return "100.0";
  const rounded = Math.round(pct * 10) / 10;
  if (rounded >= 100) return "99.9";
  if (rounded <= 0) return "0.1";
  return rounded.toFixed(1);
}

// ---------------------------------------------------------------------------
// Heartbeats
// ---------------------------------------------------------------------------

/**
 * How long a heartbeat may go quiet before the block flags it.
 *
 * The sweep is scheduled hourly, so one missed tick is inside normal
 * jitter (a slow cycle, a deploy restart, a clock that drifted a minute).
 * Two consecutive misses are not: at that point the scheduler itself is
 * the most likely suspect. 2h is therefore the first duration that cannot
 * be explained by a single late run.
 */
export const HEARTBEAT_STALE_MS = 2 * 60 * 60 * 1000;

export type HeartbeatKind = "never" | "fresh" | "stale";

export interface HeartbeatState {
  kind: HeartbeatKind;
  warn: boolean;
}

/**
 * Classifies one heartbeat timestamp.
 *
 * Two of these are rendered side by side and they answer different
 * questions — that is the whole point of keeping both:
 *  - lastScanAt stale  => the sweep is not running.
 *  - lastScanAt fresh but lastWriteAt stale => the sweep is running and
 *    finding nothing to write. Healthy when coverage is high, and a
 *    symptom of an upstream/eligibility problem when it is not.
 * A single combined signal cannot tell "idle because done" from "dead".
 *
 * `never` (null, or a timestamp the runtime cannot parse) warns rather
 * than staying quiet: the job has produced no evidence of ever having
 * run, which is strictly worse than stale, not better.
 *
 * A timestamp in the future reads as fresh. Container/host clock skew is
 * far more common than a real backfill from the future, and a skew of a
 * few seconds must not raise an alarm.
 *
 * `staleMs` is a parameter and not a hardcoded read of the constant
 * because the two heartbeats have genuinely different silence budgets —
 * the scan is supposed to tick hourly, the writer is not. Use this
 * directly for lastScanAt; route lastWriteAt through
 * {@link writeHeartbeatState}, which knows the extra fact that makes its
 * silence readable.
 */
export function heartbeatState(
  lastAt: string | null,
  now: Date,
  staleMs: number = HEARTBEAT_STALE_MS,
): HeartbeatState {
  if (!lastAt) return { kind: "never", warn: true };
  const ts = Date.parse(lastAt);
  if (Number.isNaN(ts)) return { kind: "never", warn: true };
  const age = now.getTime() - ts;
  if (age < staleMs) return { kind: "fresh", warn: false };
  return { kind: "stale", warn: true };
}

/**
 * Classifies the *write* heartbeat, which cannot be judged on age alone.
 *
 * Applying the scan's 2h budget to lastWriteAt produces a permanently
 * yellow panel, and it is not a close call — it is the steady state of
 * this exact deployment. Once a pass drains the backlog, every remaining
 * eligible row is either done or inside its 30-day cooldown, so the next
 * write is legitimately up to a month away. An indicator that is amber
 * for 29 days out of 30 teaches the operator to ignore it, and the
 * scan-stopped alarm sits in the same block.
 *
 * Stretching the budget to a week instead just trades the false alarm for
 * a missed one: workers wedged with a full queue would go a week before
 * anything showed.
 *
 * The way out is that "quiet" and "stuck" are distinguishable — with the
 * count of rows the next scan is due to pick up, which is precisely what
 * descriptionCn.pending is (admin.sql's desc_cn_pending is the same
 * predicate as ListDescriptionCnCandidates):
 *
 *  - pending = 0: there is nothing to write. Silence of any length is the
 *    job working as designed, so this never warns — the age is still
 *    reported, it just is not evidence of a fault.
 *  - pending > 0: work is waiting and the writer is not touching it. Past
 *    the scan budget that is a wedge (dead worker, exhausted request
 *    budget, a gate rejecting everything without stamping), and it
 *    surfaces in 2h rather than a week.
 *
 * This is the same discriminator D2 asks the two heartbeats for, applied
 * one level down: scan-alive answers "is it running", pending answers
 * "should it have been writing".
 */
export function writeHeartbeatState(
  lastWriteAt: string | null,
  now: Date,
  pending: number,
  staleMs: number = HEARTBEAT_STALE_MS,
): HeartbeatState {
  const base = heartbeatState(lastWriteAt, now, staleMs);
  if (safeCount(pending) === 0) return { kind: base.kind, warn: false };
  return base;
}

/** Coarse age bucket for a heartbeat, ready for an i18n lookup. */
export type RelativeAgeUnit = "day" | "hour" | "minute" | "now";

export interface RelativeAge {
  value: number;
  unit: RelativeAgeUnit;
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Buckets a heartbeat's age into {value, unit} for the caller to feed to
 * t(). Returns null for "never" — null, or a timestamp that will not
 * parse — matching {@link heartbeatState}'s `never`, so the two cannot
 * disagree about whether a heartbeat exists.
 *
 * The unit key is returned rather than a formatted string for the same
 * reason {@link backfillHealth} returns an enum: this module stays free
 * of display prose, and "3 小时前" cannot be assembled here without
 * pinning the panel to one language.
 *
 * `now` is required, not defaulted to `new Date()`. Two reasons, and the
 * second is the one that bites: a hidden clock makes the function
 * untestable, and calling `new Date()` during render in an SSR'd tree
 * gives the server and the client different text for the same node —
 * a hydration mismatch. The caller must hold `now` in state and refresh
 * it on the poll tick, which is also what makes the displayed age
 * actually advance.
 *
 * Ages are floored, so "1 hour" means "between 1 and 2 hours" — the
 * conventional reading, and it never rounds a 119-minute silence up to
 * the friendlier-sounding "2 hours". A future timestamp (clock skew)
 * clamps to "now" rather than reporting a negative age.
 */
export function relativeAge(lastAt: string | null, now: Date): RelativeAge | null {
  if (!lastAt) return null;
  const ts = Date.parse(lastAt);
  if (Number.isNaN(ts)) return null;
  const age = now.getTime() - ts;
  if (age < MINUTE_MS) return { value: 0, unit: "now" };
  if (age < HOUR_MS) return { value: Math.floor(age / MINUTE_MS), unit: "minute" };
  if (age < DAY_MS) return { value: Math.floor(age / HOUR_MS), unit: "hour" };
  return { value: Math.floor(age / DAY_MS), unit: "day" };
}

// ---------------------------------------------------------------------------
// Queue health
// ---------------------------------------------------------------------------

/**
 * Why the queue is unhealthy. Enum keys, not prose — the UI layer owns
 * the wording (and its zh/en variants); this module stays language-free.
 */
export type BackfillHealthReason = "discarded" | "retrying";

export interface BackfillHealth {
  warn: boolean;
  reason: BackfillHealthReason | null;
}

/**
 * Judges the queue from its per-state counters.
 *
 * `queued` is deliberately *not* part of the verdict: a perpetual sweep
 * having work in front of it is its normal resting state, and warning on
 * it would keep the block permanently yellow. Only the two failure states
 * count.
 *
 * `discarded` outranks `retrying` when both are non-zero: retries are
 * still in flight and may yet succeed, while a discarded job is a row
 * that will never get its description unless someone requeues it. The
 * more actionable fact wins the single reason slot.
 *
 * Splitting these two out is the reason this function exists at all —
 * folding `retrying` into a single "pending work" total is what makes a
 * Bangumi outage look like a busy-but-healthy queue.
 */
export function backfillHealth(q: BackfillQueueCounts): BackfillHealth {
  if (safeCount(q.discarded) > 0) return { warn: true, reason: "discarded" };
  if (safeCount(q.retrying) > 0) return { warn: true, reason: "retrying" };
  return { warn: false, reason: null };
}

// ---------------------------------------------------------------------------
// Polling cadence
// ---------------------------------------------------------------------------

/**
 * Poll cadence for the backfill block: 30s.
 *
 * Everything it shows moves on an hourly scale (coverage creeps, the scan
 * heartbeat updates once an hour), so the existing 2s/5s enrichment
 * cadences would buy nothing but /api/admin/stats load — and that endpoint
 * now costs ~337ms because of these very queries.
 */
export const BACKFILL_POLL_MS = 30_000;

/**
 * Folds the backfill cadence into whatever cadence the enrichment queue
 * already asked for, and returns the timer EnrichmentBar should arm.
 *
 * The trap this exists to close: EnrichmentBar's own `pickInterval`
 * returns **0 for "idle, stop polling"**, and idle is the steady state on
 * a quiet day. Naively taking `Math.min(existing, 30_000)` would pick 0
 * and freeze the backfill block on whatever it rendered at page load —
 * so a sweep that died an hour later would keep showing a fresh
 * heartbeat until someone reloaded. This function therefore never
 * returns 0.
 *
 * Usage in EnrichmentBar (do not change pickInterval itself):
 *   const interval = pickBackfillInterval(pickInterval(stats));
 *
 * @param enrichmentIntervalMs result of EnrichmentBar's pickInterval;
 *        0 means "enrichment needs no polling".
 */
export function pickBackfillInterval(enrichmentIntervalMs: number): number {
  if (!Number.isFinite(enrichmentIntervalMs) || enrichmentIntervalMs <= 0) {
    return BACKFILL_POLL_MS;
  }
  return Math.min(enrichmentIntervalMs, BACKFILL_POLL_MS);
}

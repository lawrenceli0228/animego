import { describe, expect, test } from "bun:test";
import {
  BACKFILL_POLL_MS,
  HEARTBEAT_STALE_MS,
  backfillHealth,
  coveragePct,
  formatCoveragePct,
  heartbeatState,
  ineligibleCount,
  pickBackfillInterval,
  relativeAge,
  writeHeartbeatState,
} from "./backfillStatus";

describe("coveragePct", () => {
  test("returns 0 (not NaN) when eligible is 0", () => {
    // The failure this pins down: a fresh/empty database has an empty
    // description_cn_eligible view, so 0/0 is the *first* input the
    // block ever sees. Unguarded it renders "NaN%" and, worse, any
    // downstream width/threshold arithmetic silently turns NaN too.
    expect(coveragePct(0, 0)).toBe(0);
    expect(Number.isNaN(coveragePct(0, 0))).toBe(false);
  });

  test("returns 0 when eligible is 0 even if done is somehow non-zero", () => {
    // Two separate queries: `done` counted before a purge, `eligible`
    // after. Must not divide by zero into Infinity.
    expect(coveragePct(42, 0)).toBe(0);
    expect(Number.isFinite(coveragePct(42, 0))).toBe(true);
  });

  test("computes the plain ratio for ordinary input", () => {
    expect(coveragePct(50, 200)).toBe(25);
    expect(coveragePct(1, 3)).toBeCloseTo(33.3333, 3);
  });

  test("returns 100 when every eligible row is done", () => {
    expect(coveragePct(1200, 1200)).toBe(100);
  });

  test("caps at 100 when done exceeds eligible", () => {
    // stats.descriptionCn.done and .eligible come from separate queries;
    // a sweep writing between them makes done > eligible for one poll.
    // A gauge fed 103 draws past its track.
    expect(coveragePct(103, 100)).toBe(100);
  });

  test("floors at 0 for negative done", () => {
    expect(coveragePct(-5, 100)).toBe(0);
  });

  test("returns 0 for negative eligible instead of a negative percentage", () => {
    expect(coveragePct(10, -100)).toBe(0);
  });

  test("returns 0 for non-finite input rather than propagating NaN", () => {
    // A malformed/absent JSON field arrives as undefined -> NaN once it
    // hits arithmetic. Stop it at the boundary.
    expect(coveragePct(Number.NaN, 100)).toBe(0);
    expect(coveragePct(10, Number.NaN)).toBe(0);
    expect(coveragePct(Number.POSITIVE_INFINITY, 100)).toBe(0);
  });
});

describe("formatCoveragePct", () => {
  test("never rounds an incomplete sweep up to 100.0", () => {
    // 17000 of 17010 rows is 99.94%. Printing "100.0" tells the operator
    // the backlog is gone while 10 rows are still waiting — the exact
    // misreading this whole block was built to prevent.
    expect(formatCoveragePct(coveragePct(17000, 17010))).toBe("99.9");
    expect(formatCoveragePct(99.99)).toBe("99.9");
  });

  test("prints 100.0 only when coverage is genuinely complete", () => {
    expect(formatCoveragePct(coveragePct(500, 500))).toBe("100.0");
    expect(formatCoveragePct(100)).toBe("100.0");
  });

  test("never rounds a non-zero coverage down to 0.0", () => {
    // "has never written anything" and "has written a handful" are
    // different states; 1/100000 must not read as the former.
    expect(formatCoveragePct(coveragePct(1, 100000))).toBe("0.1");
    expect(formatCoveragePct(0.004)).toBe("0.1");
  });

  test("prints 0.0 for genuine zero coverage", () => {
    expect(formatCoveragePct(coveragePct(0, 5000))).toBe("0.0");
  });

  test("prints one decimal place for ordinary values", () => {
    expect(formatCoveragePct(63.84)).toBe("63.8");
    expect(formatCoveragePct(25)).toBe("25.0");
  });

  test("degrades to 0.0 on non-finite input instead of printing NaN", () => {
    expect(formatCoveragePct(Number.NaN)).toBe("0.0");
    expect(formatCoveragePct(-3)).toBe("0.0");
  });
});

describe("heartbeatState", () => {
  const now = new Date("2026-08-06T12:00:00.000Z");
  const iso = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();

  test("null reads as never and warns", () => {
    // A sweep that has never scanned (job never registered, migration
    // applied but worker not deployed) must be loud, not blank.
    expect(heartbeatState(null, now)).toEqual({ kind: "never", warn: true });
  });

  test("a timestamp minutes old is fresh and does not warn", () => {
    expect(heartbeatState(iso(5 * 60 * 1000), now)).toEqual({
      kind: "fresh",
      warn: false,
    });
  });

  test("one missed hourly tick is still fresh (normal jitter)", () => {
    // 90 minutes: a slow cycle or a deploy restart. Warning here would
    // train the operator to ignore the indicator.
    expect(heartbeatState(iso(90 * 60 * 1000), now)).toEqual({
      kind: "fresh",
      warn: false,
    });
  });

  test("just under 2h is fresh; exactly 2h is already stale", () => {
    // Boundary is closed on the stale side: "< 2h => fresh, otherwise
    // stale". Pinned so a later refactor cannot silently flip the
    // comparison and hide a two-hour outage.
    expect(heartbeatState(iso(HEARTBEAT_STALE_MS - 1), now).kind).toBe("fresh");
    expect(heartbeatState(iso(HEARTBEAT_STALE_MS), now)).toEqual({
      kind: "stale",
      warn: true,
    });
  });

  test("two missed hourly ticks read as stale and warn", () => {
    expect(heartbeatState(iso(3 * 60 * 60 * 1000), now)).toEqual({
      kind: "stale",
      warn: true,
    });
  });

  test("a days-old heartbeat is stale, not wrapped back to fresh", () => {
    expect(heartbeatState(iso(9 * 24 * 60 * 60 * 1000), now).kind).toBe("stale");
  });

  test("a future timestamp reads as fresh (clock skew is not an outage)", () => {
    // go-api container clock a few seconds ahead of the browser is
    // ordinary; it must not paint the block red.
    expect(heartbeatState(iso(-30 * 1000), now)).toEqual({
      kind: "fresh",
      warn: false,
    });
  });

  test("an unparseable timestamp reads as never and warns", () => {
    // Rather than Date.parse -> NaN -> `NaN < threshold` === false ->
    // silently "stale", which would misreport a serialization bug as an
    // outage. Both warn, but the label should be honest.
    expect(heartbeatState("not-a-date", now)).toEqual({
      kind: "never",
      warn: true,
    });
  });

  test("an empty string reads as never rather than epoch-stale", () => {
    expect(heartbeatState("", now)).toEqual({ kind: "never", warn: true });
  });

  test("accepts the Go RFC3339 shape go-api actually emits", () => {
    // time.Time marshals with a nanosecond fraction and +00:00 offset,
    // not the JS "Z" form — make sure that parses.
    expect(heartbeatState("2026-08-06T11:30:00.123456789+00:00", now).kind).toBe(
      "fresh",
    );
  });
});

describe("coveragePct against the live schema", () => {
  test("reproduces the SQL percentage for the current local database", () => {
    // Counted with:
    //   SELECT count(*) FILTER (WHERE description_cn IS NOT NULL)
    //          * 100.0 / NULLIF(count(*), 0) FROM description_cn_eligible;
    // -> 69.2307692307692308 on 13 eligible / 9 done.
    // The point of this test is the dashboard's core promise: an operator
    // who does not believe the number can count it by hand and get the
    // same digits.
    expect(coveragePct(9, 13)).toBeCloseTo(69.23076923076923, 10);
    expect(formatCoveragePct(coveragePct(9, 13))).toBe("69.2");
  });

  test("ineligible rows are the catalogue remainder, not part of coverage", () => {
    // 285 rows in anime_cache, 13 in the eligible view. Coverage is
    // measured against 13; the other 272 can never be backfilled and must
    // be reported separately, or "69.2%" reads as a claim about the whole
    // catalogue.
    expect(ineligibleCount(285, 13)).toBe(272);
  });
});

describe("ineligibleCount", () => {
  test("clamps to 0 rather than reporting a negative remainder", () => {
    // The eligible view is a subset of anime_cache, so this can only come
    // from two payloads taken at different moments. "-4 ineligible" is
    // nonsense to render.
    expect(ineligibleCount(10, 13)).toBe(0);
  });

  test("degrades to 0 on non-finite input", () => {
    expect(ineligibleCount(Number.NaN, 13)).toBe(0);
    expect(ineligibleCount(285, Number.NaN)).toBe(285);
  });

  test("an empty catalogue has no ineligible rows", () => {
    expect(ineligibleCount(0, 0)).toBe(0);
  });
});

describe("writeHeartbeatState", () => {
  const now = new Date("2026-08-06T12:00:00.000Z");
  const iso = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();
  const DAYS = 24 * 60 * 60 * 1000;

  test("does not warn about a long silence when there is nothing to write", () => {
    // The steady state of this deployment, and the reason this function
    // exists: once a pass drains the backlog every remaining row is done
    // or inside its 30-day cooldown, so the next write is legitimately
    // weeks away. Judged on age alone the panel is amber ~29 days out of
    // 30, which trains the operator to ignore the block the scan alarm
    // also lives in.
    expect(writeHeartbeatState(iso(20 * DAYS), now, 0)).toEqual({
      kind: "stale",
      warn: false,
    });
  });

  test("still reports the age honestly while suppressing the alarm", () => {
    // warn is the alarm, kind is the fact. Idle must not rewrite the fact
    // to "fresh" — the operator should still see that it has been 20 days.
    expect(writeHeartbeatState(iso(20 * DAYS), now, 0).kind).toBe("stale");
  });

  test("warns when work is waiting and nothing has been written", () => {
    // Wedged writer: dead worker, exhausted request budget, or a gate
    // rejecting everything without stamping attempted_at. Surfaces in 2h
    // instead of the week a blanket long threshold would have cost.
    expect(writeHeartbeatState(iso(3 * 60 * 60 * 1000), now, 4200)).toEqual({
      kind: "stale",
      warn: true,
    });
  });

  test("a recent write never warns, even with a large backlog", () => {
    // Draining a big backlog is the healthy case, not an alarm.
    expect(writeHeartbeatState(iso(10 * 60 * 1000), now, 4200)).toEqual({
      kind: "fresh",
      warn: false,
    });
  });

  test("never-written with work waiting is an alarm", () => {
    // Worker never deployed / job never registered, while pending says
    // there is something for it to do.
    expect(writeHeartbeatState(null, now, 9100)).toEqual({
      kind: "never",
      warn: true,
    });
  });

  test("never-written with nothing to write is quiet", () => {
    // A fully-covered (or empty) library that has never needed a write.
    expect(writeHeartbeatState(null, now, 0)).toEqual({
      kind: "never",
      warn: false,
    });
  });

  test("a negative or non-finite pending count is treated as no work", () => {
    // A missing wire field must not fabricate a wedge alarm.
    expect(writeHeartbeatState(iso(30 * DAYS), now, Number.NaN).warn).toBe(false);
    expect(writeHeartbeatState(iso(30 * DAYS), now, -1).warn).toBe(false);
  });
});

describe("heartbeatState staleMs override", () => {
  const now = new Date("2026-08-06T12:00:00.000Z");
  const iso = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();

  test("defaults to the scan budget when no threshold is passed", () => {
    // The declared two-argument contract must keep working unchanged.
    expect(heartbeatState(iso(HEARTBEAT_STALE_MS + 1), now).kind).toBe("stale");
  });

  test("honours a caller-supplied budget", () => {
    const sixHours = 6 * 60 * 60 * 1000;
    expect(heartbeatState(iso(3 * 60 * 60 * 1000), now, sixHours).kind).toBe("fresh");
    expect(heartbeatState(iso(7 * 60 * 60 * 1000), now, sixHours).kind).toBe("stale");
  });
});

describe("relativeAge", () => {
  const now = new Date("2026-08-06T12:00:00.000Z");
  const iso = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();

  test("null and unparseable agree with heartbeatState's 'never'", () => {
    // If these two ever disagree the panel prints an age next to a
    // "never" label, or the reverse.
    expect(relativeAge(null, now)).toBeNull();
    expect(relativeAge("not-a-date", now)).toBeNull();
    expect(heartbeatState(null, now).kind).toBe("never");
    expect(heartbeatState("not-a-date", now).kind).toBe("never");
  });

  test("under a minute is 'now'", () => {
    expect(relativeAge(iso(30 * 1000), now)).toEqual({ value: 0, unit: "now" });
  });

  test("buckets minutes, hours and days", () => {
    expect(relativeAge(iso(5 * 60 * 1000), now)).toEqual({ value: 5, unit: "minute" });
    expect(relativeAge(iso(3 * 60 * 60 * 1000), now)).toEqual({ value: 3, unit: "hour" });
    expect(relativeAge(iso(9 * 24 * 60 * 60 * 1000), now)).toEqual({
      value: 9,
      unit: "day",
    });
  });

  test("floors instead of rounding up", () => {
    // 119 minutes must not present itself as the friendlier "2 hours".
    expect(relativeAge(iso(119 * 60 * 1000), now)).toEqual({ value: 1, unit: "hour" });
  });

  test("clamps a future timestamp to 'now' rather than a negative age", () => {
    // Same clock-skew tolerance heartbeatState has; "-1 minutes ago" is
    // not a thing to render.
    expect(relativeAge(iso(-30 * 1000), now)).toEqual({ value: 0, unit: "now" });
  });

  test("returns a unit key, never display prose", () => {
    const rel = relativeAge(iso(3 * 60 * 60 * 1000), now);
    expect(/[一-鿿]/.test(rel?.unit ?? "")).toBe(false);
  });
});

describe("backfillHealth", () => {
  test("all zero is healthy and gives no reason", () => {
    // Steady state on a fully-covered library: nothing queued, nothing
    // failing. Must stay quiet or the indicator is worthless.
    expect(backfillHealth({ queued: 0, retrying: 0, discarded: 0 })).toEqual({
      warn: false,
      reason: null,
    });
  });

  test("a large healthy backlog does not warn", () => {
    // A perpetual sweep with work in front of it is normal. Warning on
    // `queued` would leave the block permanently yellow.
    expect(backfillHealth({ queued: 4200, retrying: 0, discarded: 0 })).toEqual({
      warn: false,
      reason: null,
    });
  });

  test("retrying > 0 warns with reason 'retrying'", () => {
    // The Bangumi-outage case. Folded into a single "pending" total this
    // is invisible; split out it is the first sign of an upstream fault.
    expect(backfillHealth({ queued: 0, retrying: 1, discarded: 0 })).toEqual({
      warn: true,
      reason: "retrying",
    });
  });

  test("discarded > 0 warns with reason 'discarded'", () => {
    // Retries exhausted: these rows are dropped for good unless someone
    // requeues them. Nothing else in the UI would surface that.
    expect(backfillHealth({ queued: 0, retrying: 0, discarded: 7 })).toEqual({
      warn: true,
      reason: "discarded",
    });
  });

  test("discarded outranks retrying when both are non-zero", () => {
    // Single reason slot goes to the permanent loss, not the transient one.
    expect(backfillHealth({ queued: 3, retrying: 12, discarded: 2 })).toEqual({
      warn: true,
      reason: "discarded",
    });
  });

  test("returns a reason key, never display prose", () => {
    // The UI layer owns zh/en wording; a Chinese string leaking out of
    // here would be untranslatable at the call site.
    const reason = backfillHealth({ queued: 0, retrying: 1, discarded: 0 }).reason;
    expect(reason).toBe("retrying");
    expect(/[一-鿿]/.test(reason ?? "")).toBe(false);
  });

  test("negative and non-finite counters degrade to healthy, not to a warning", () => {
    // A missing wire field must not fabricate an alert.
    expect(
      backfillHealth({ queued: 0, retrying: -1, discarded: Number.NaN }),
    ).toEqual({ warn: false, reason: null });
  });
});

describe("pickBackfillInterval", () => {
  test("polls at 30s when enrichment is idle (interval 0)", () => {
    // The trap: EnrichmentBar's pickInterval returns 0 for "stop
    // polling", which is the steady state. Math.min(0, 30_000) would be
    // 0 and freeze the heartbeat on its page-load value — a sweep that
    // died an hour later would still look fresh until a manual reload.
    expect(pickBackfillInterval(0)).toBe(BACKFILL_POLL_MS);
    expect(pickBackfillInterval(0)).toBe(30_000);
  });

  test("keeps the faster enrichment cadence when V3 is running", () => {
    // Backfill piggybacks on the existing poll; it must never slow the
    // 2s V3 progress bar down to 30s.
    expect(pickBackfillInterval(2000)).toBe(2000);
    expect(pickBackfillInterval(5000)).toBe(5000);
  });

  test("caps at 30s when enrichment asks for something slower", () => {
    expect(pickBackfillInterval(60_000)).toBe(BACKFILL_POLL_MS);
  });

  test("never returns 0 or a negative timer", () => {
    // setTimeout(fn, 0) would busy-poll /api/admin/stats, which now
    // costs ~337ms per call.
    expect(pickBackfillInterval(-1)).toBe(BACKFILL_POLL_MS);
    expect(pickBackfillInterval(Number.NaN)).toBe(BACKFILL_POLL_MS);
  });
});

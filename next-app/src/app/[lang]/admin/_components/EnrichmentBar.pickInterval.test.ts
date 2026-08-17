import { describe, expect, test } from "bun:test";

import { pickInterval } from "./EnrichmentBar";
import { BACKFILL_POLL_MS } from "@/lib/backfillStatus";
import type { AdminStats, BackfillQueue } from "../_types";

// pickInterval is the one judgement left inside the component, and the
// backfill work added a fourth branch to it. Two things need pinning:
//
//  1. the new branch really is the 30s tier (D3) — 22,320 requests is what
//     the 5s tier would have cost over the ~31h first pass, and
//  2. nothing about it touched the existing 2s/5s tiers. Those drive the
//     live enrichment progress bar, which an operator watches while a heal
//     run is going; slowing them to 30s would be a silent regression in a
//     feature this work was not supposed to touch at all.

const EMPTY_BACKFILL: BackfillQueue = {
  queued: 0,
  retrying: 0,
  discarded: 0,
  lastScanAt: null,
  lastWriteAt: null,
};

// `descriptionBackfill` is carved out of the Partial and re-declared: an
// intersection would put the required BackfillQueue back and force every
// case to spell out all five fields.
type QueueOverride = Omit<Partial<AdminStats["queue"]>, "descriptionBackfill"> & {
  descriptionBackfill?: Partial<BackfillQueue>;
};

function stats(queue: QueueOverride = {}): AdminStats {
  return {
    users: 0,
    anime: 285,
    enrichment: {
      v0: 0,
      v1: 0,
      v2: 0,
      v3: 0,
      noCn: 0,
      hasCn: 0,
      healCnReal: 0,
      cnStuck: 0,
      srcIdMap: 0,
      srcFuzzyHigh: 0,
      srcFuzzyLow: 0,
    },
    queue: {
      phase1: 0,
      phase4: 0,
      v3: 0,
      ...queue,
      descriptionBackfill: {
        ...EMPTY_BACKFILL,
        ...(queue.descriptionBackfill ?? {}),
      },
      // pickInterval deliberately ignores this queue (the LLM sweep has
      // its own hourly cadence and no bearing on the panel's poll rate),
      // but the payload shape requires it.
      descriptionLlm: {
        ...EMPTY_BACKFILL,
        ...(queue.descriptionLlm ?? {}),
      },
    },
    descriptionCn: { eligible: 13, done: 9, rejected: 4, pending: 0 },
    descriptionCnLlm: { remit: 40, done: 24, rejected: 6, pending: 10 },
    flagged: 0,
    subscriptions: 0,
    follows: 0,
  };
}

describe("pickInterval — existing enrichment tiers (regression guard)", () => {
  test("a running V3 batch still polls at 2s", () => {
    expect(
      pickInterval(stats({ v3Progress: { processed: 10, total: 100 } })),
    ).toBe(2000);
  });

  test("a backlog of enrichment jobs still polls at 5s", () => {
    expect(pickInterval(stats({ phase1: 3 }))).toBe(5000);
    expect(pickInterval(stats({ phase4: 3 }))).toBe(5000);
    expect(pickInterval(stats({ v3: 3 }))).toBe(5000);
  });

  test("a full backfill queue does NOT slow the running-V3 tier", () => {
    expect(
      pickInterval(
        stats({
          v3Progress: { processed: 10, total: 100 },
          descriptionBackfill: { queued: 4000 },
        }),
      ),
    ).toBe(2000);
  });

  test("a full backfill queue does NOT slow the enrichment-backlog tier", () => {
    expect(
      pickInterval(stats({ phase1: 3, descriptionBackfill: { queued: 4000 } })),
    ).toBe(5000);
  });

  test("a paused V3 batch drops out of the 2s tier, as before", () => {
    expect(
      pickInterval(
        stats({ v3Progress: { processed: 10, total: 100, paused: true } }),
      ),
    ).toBe(0);
  });

  test("a finished V3 batch drops out of the 2s tier, as before", () => {
    expect(
      pickInterval(stats({ v3Progress: { processed: 100, total: 100 } })),
    ).toBe(0);
  });
});

describe("pickInterval — backfill tier", () => {
  test("real backfill work polls at 30s, not at the enrichment cadence", () => {
    expect(pickInterval(stats({ descriptionBackfill: { queued: 47 } }))).toBe(
      BACKFILL_POLL_MS,
    );
    expect(pickInterval(stats({ descriptionBackfill: { queued: 47 } }))).toBe(
      30_000,
    );
  });

  test("jobs in retry keep the block refreshing — that is when it matters", () => {
    // An upstream outage drains `queued` into `retrying`. If only `queued`
    // armed the timer, the panel would freeze at the exact moment its
    // numbers started telling the operator something.
    expect(pickInterval(stats({ descriptionBackfill: { retrying: 47 } }))).toBe(
      BACKFILL_POLL_MS,
    );
  });

  test("discarded jobs alone do not pin the poller on", () => {
    // Terminal state: nobody will pick them up, so the counter cannot move
    // and re-fetching it forever buys nothing. It is a thing to look at,
    // not work in flight.
    expect(pickInterval(stats({ descriptionBackfill: { discarded: 12 } }))).toBe(
      0,
    );
  });

  test("an idle panel stops polling entirely", () => {
    expect(pickInterval(stats())).toBe(0);
  });
});

describe("pickInterval — payload from an older go-api", () => {
  test("a missing descriptionBackfill reads as idle instead of throwing", () => {
    // Rolling deploy: next-app is new, go-api is not. Reading `.queued` off
    // undefined here would take down the whole /admin page, not just this
    // block.
    const legacy = stats();
    delete (legacy.queue as { descriptionBackfill?: unknown })
      .descriptionBackfill;
    expect(() => pickInterval(legacy)).not.toThrow();
    expect(pickInterval(legacy)).toBe(0);
  });

  test("a missing descriptionBackfill still honours the enrichment tiers", () => {
    const legacy = stats({ phase1: 3 });
    delete (legacy.queue as { descriptionBackfill?: unknown })
      .descriptionBackfill;
    expect(pickInterval(legacy)).toBe(5000);
  });
});

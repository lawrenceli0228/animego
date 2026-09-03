import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { EnrichmentBar } from "./EnrichmentBar";
import type { AdminStats, BackfillQueue } from "../_types";

// Why a render test in a repo with no DOM test stack (D7 said not to add
// one — and this does not: renderToStaticMarkup is react-dom/server, no
// jsdom, no testing-library, no new dependency):
//
// backfillStatus.ts is 100% covered by pure unit tests, and the component
// still shipped with three of those functions unused — it re-derived the
// ineligible count inline and judged the write heartbeat with the SCAN's
// budget, which turns the panel permanently amber the moment coverage
// saturates. Pure-function coverage cannot catch a caller that does not
// call. This file asserts the wiring: that the numbers reaching the screen
// are the ones the tested functions produce.
//
// Every timestamp is built RELATIVE to the moment the test runs. The
// component reads the wall clock (that is the point of a heartbeat), so a
// hardcoded ISO string would make "217 天前" true only on the day the
// fixture was written. Ages are floored and rendering happens a few
// milliseconds after these are computed, so each one lands on exactly the
// bucket it names.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** ISO timestamp `ms` in the past, from the same clock the component reads. */
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

function statsFor(over: Partial<AdminStats> = {}): AdminStats {
  return {
    users: 0,
    // Live local database, reproduced by hand:
    //   SELECT (SELECT count(*) FROM anime_cache),
    //          (SELECT count(*) FROM description_cn_eligible), ...
    //   => 285 | 13 | 9 | 4 | 0
    anime: 285,
    enrichment: {
      v0: 0, v1: 0, v2: 0, v3: 0, noCn: 0, hasCn: 0,
      healCnReal: 0, cnStuck: 0, subjectUnreadable: 0,
      srcIdMap: 0, srcFuzzyHigh: 0, srcFuzzyLow: 0,
    },
    queue: {
      phase1: 0, phase4: 0, v3: 0,
      descriptionBackfill: {
        queued: 0, retrying: 0, discarded: 0,
        lastScanAt: ago(37 * MIN),
        lastWriteAt: ago(100 * MIN),
      },
      // The LLM tier defaults to healthy so assertions aimed at the
      // Bangumi block above are not polluted by a second block's alarms
      // — several of them assert on the whole rendered page.
      descriptionLlm: {
        queued: 0, retrying: 0, discarded: 0,
        lastScanAt: ago(12 * MIN),
        lastWriteAt: ago(20 * MIN),
      },
    },
    descriptionCn: { eligible: 13, done: 9, rejected: 4, pending: 0 },
    descriptionCnLlm: { remit: 40, done: 24, rejected: 6, pending: 10 },
    flagged: 0, subscriptions: 0, follows: 0,
    ...over,
  };
}

/** Rendered text with tags and entities out of the way. */
function text(stats: AdminStats): string {
  return renderToStaticMarkup(<EnrichmentBar initial={stats} />)
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");
}

function withQueue(over: Partial<BackfillQueue>): AdminStats {
  const s = statsFor();
  s.queue.descriptionBackfill = { ...s.queue.descriptionBackfill, ...over };
  return s;
}

describe("coverage numbers are the SQL numbers", () => {
  test("done/eligible and the percentage come straight off the view counts", () => {
    // SELECT count(*) FILTER (WHERE description_cn IS NOT NULL) || '/' ||
    //        count(*) FROM description_cn_eligible;  => 9/13 => 69.23%
    expect(text(statsFor())).toContain("9 / 13 (69.2%)");
  });

  test("ineligible is anime_cache minus the eligible view, not a guess", () => {
    // 285 - 13. Shown so 69.2% cannot be misread as 69.2% of the catalogue.
    expect(text(statsFor())).toContain("无资格 272");
  });

  test("rejected and pending are reported separately, never summed", () => {
    const html = text(statsFor());
    expect(html).toContain("已拒(多为日文) 4");
    expect(html).toContain("待处理 0");
  });

  test("an empty database reads 0.0%, never NaN%", () => {
    const html = text(
      statsFor({
        anime: 0,
        descriptionCn: { eligible: 0, done: 0, rejected: 0, pending: 0 },
      }),
    );
    expect(html).toContain("0 / 0 (0.0%)");
    expect(html).not.toContain("NaN");
  });
});

describe("a failing sweep never renders as a healthy one", () => {
  test("retryable is shown as retrying, not folded into the queued depth", () => {
    // The exact lie this block exists to prevent: a bgm.tv outage drains
    // `queued` into `retryable`. Summed, the depth stays comfortably
    // non-zero and reads as a busy, healthy queue.
    const html = text(withQueue({ queued: 0, retrying: 47, discarded: 12 }));
    expect(html).toContain("回填队列 0 排队");
    expect(html).toContain("47 重试中 ⚠");
    expect(html).toContain("12 已放弃 ⚠");
  });

  test("a heartbeat with no record alarms instead of reading as 0 or fresh", () => {
    const html = text(withQueue({ lastScanAt: null }));
    expect(html).toContain("上次扫描 从未 ⚠");
  });

  test("a scan silent past two hourly ticks alarms", () => {
    const html = text(withQueue({ lastScanAt: ago(26 * HOUR) }));
    expect(html).toContain("⚠");
    expect(html).not.toContain("上次扫描 从未");
  });
});

describe("the write heartbeat is judged with pending, not with the scan budget", () => {
  // Straight heartbeatState here would make both cases identical, and the
  // steady state of this deployment is the first one — an indicator amber
  // 29 days out of 30 is an indicator nobody reads.
  test("a long silence with nothing to write does not alarm", () => {
    const s = withQueue({ lastWriteAt: ago(217 * DAY) });
    s.descriptionCn = { ...s.descriptionCn, pending: 0 };
    const html = text(s);
    expect(html).toContain("上次写入 217 天前");
    expect(html).not.toContain("上次写入 217 天前 ⚠");
  });

  test("the same silence with work waiting is a wedged writer", () => {
    const s = withQueue({ lastWriteAt: ago(217 * DAY) });
    s.descriptionCn = { ...s.descriptionCn, pending: 312 };
    expect(text(s)).toContain("上次写入 217 天前 ⚠");
  });
});

describe("a stats payload from an older go-api", () => {
  test("renders zeroes instead of taking the whole /admin page down", () => {
    // Rolling deploy window: next-app is new, go-api is not. Reading
    // `.done` off undefined would throw during render, and this is the
    // least important block on the page.
    const legacy = statsFor();
    delete (legacy as { descriptionCn?: unknown }).descriptionCn;
    delete (legacy.queue as { descriptionBackfill?: unknown })
      .descriptionBackfill;

    let html = "";
    expect(() => { html = text(legacy); }).not.toThrow();
    expect(html).toContain("0 / 0 (0.0%)");
    // The rest of the bar still renders.
    expect(html).toContain("Heal CN");
  });
});

describe("the existing enrichment bar is untouched", () => {
  test("v3/v2/v1/v0, the CN coverage line and the action buttons all survive", () => {
    const s = statsFor();
    s.enrichment = { ...s.enrichment, v3: 100, v2: 50, v1: 30, v0: 20, hasCn: 120, healCnReal: 7 };
    const html = text(s);
    expect(html).toContain("v3 100 · v2 50 · v1 30 · v0 20");
    expect(html).toContain("中文覆盖");
    expect(html).toContain("Heal CN (7)");
    expect(html).toContain("Re-enrich v1 (30)");
    expect(html).toContain("Re-enrich v2 (50)");
  });

  test("a running V3 batch still shows its own processed/total progress", () => {
    const s = statsFor();
    s.queue.v3Progress = { processed: 40, total: 100 };
    expect(text(s)).toContain("V3 Heal: 40/100 (40%)");
  });
});

// The bar's whole premise is that a number on it is a number an operator can
// reproduce and act on. subjectUnreadable breaks the second half of that on
// purpose: nothing can act on it short of an authenticated Bangumi client. It
// is rendered anyway because the alternative is worse — those rows are
// terminal at v3, so with no line of their own they are indistinguishable
// from fully enriched ones, and "how many bindings can we not read" stops
// being answerable from the surface that shows every other enrichment number.
describe("bindings upstream will not serve us are shown, not folded into v3", () => {
  test("the count appears on the v3 legend when there are any", () => {
    const s = statsFor();
    s.enrichment = { ...s.enrichment, v3: 900, subjectUnreadable: 811 };
    expect(text(s)).toContain("其中 811 上游不可读");
  });

  test("it is a legend note, not a button — no action exists for these rows", () => {
    const s = statsFor();
    s.enrichment = { ...s.enrichment, v3: 900, subjectUnreadable: 811 };
    const html = renderToStaticMarkup(<EnrichmentBar initial={s} />);
    // The count must not appear inside any <button>. Offering one would
    // re-create the exact defect this replaced: a control that enqueues jobs
    // upstream has already refused.
    const buttons: string[] = html.match(/<button[\s\S]*?<\/button>/g) ?? [];
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.some((b) => b.includes("811"))).toBe(false);
  });

  test("zero renders nothing at all", () => {
    const s = statsFor();
    s.enrichment = { ...s.enrichment, v3: 900, subjectUnreadable: 0 };
    expect(text(s)).not.toContain("上游不可读");
  });

  test("an older go-api that does not send the field renders without it", () => {
    // Same defensive shape as the payload test above: the bar is deployed
    // independently of go-api, so a stats response from before 0031 must not
    // put NaN on the page.
    const s = statsFor();
    const { subjectUnreadable: _dropped, ...rest } = s.enrichment;
    s.enrichment = rest as typeof s.enrichment;
    expect(text(s)).not.toContain("上游不可读");
    expect(text(s)).toContain("中文覆盖");
  });
});

describe("the heartbeat ages themselves", () => {
  test("a fresh scan reports its age in minutes and ticks the all-clear", () => {
    expect(text(statsFor())).toContain("上次扫描 37 分钟前 ✓");
  });

  test("silence is coarsened upward, never rounded down to the friendlier unit", () => {
    // 26h reads as "1 天前", not "26 小时前" and not "2 天前".
    expect(text(withQueue({ lastScanAt: ago(26 * HOUR) }))).toContain(
      "上次扫描 1 天前 ⚠",
    );
  });
});

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { HantDriftSection } from "./HantDriftSection";
import type { HantDriftStats } from "../_types";

// Same approach, and the same justification, as EnrichmentBar.render.test.tsx:
// renderToStaticMarkup is react-dom/server — no jsdom, no testing-library, no
// new dependency. hantDrift.ts is covered by pure unit tests, and pure-function
// coverage cannot catch a component that never calls them. This file asserts
// the wiring: that the numbers reaching the screen are the ones those tested
// functions produce, and that the two states an operator most needs to tell
// apart (all-clear vs drift) really do render differently.
//
// With no LanguageProvider above it, useLang() falls back to the path-derived
// locale, which for "/" is zh — so the expected strings here are the
// Simplified ones from zh-spa.js.

const MIN = 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

/** ISO timestamp `ms` in the past, from the same clock the component reads. */
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

/** The contract sheet's own sample payload. */
function statsFor(over: Partial<HantDriftStats> = {}): HantDriftStats {
  return {
    total: 17518,
    titleHant: 12350,
    descHant: 15917,
    serpEligible: 6422,
    titleBehind: 0,
    descBehind: 2,
    lastRunAt: ago(37 * MIN),
    running: false,
    ...over,
  };
}

/** Rendered text with tags and entities out of the way. */
function text(stats: HantDriftStats | null): string {
  return renderToStaticMarkup(<HantDriftSection initial={stats} />)
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ");
}

/** Rendered markup, tags intact — for assertions about attributes. */
function markup(stats: HantDriftStats | null): string {
  return renderToStaticMarkup(<HantDriftSection initial={stats} />);
}

describe("the drift counters are the wire counters", () => {
  test("both behind counts render as given, including the zero", () => {
    const html = text(statsFor());
    expect(html).toContain("标题落后 0");
    expect(html).toContain("简介落后 2");
  });

  test("the hints state the SQL predicate, so the number can be re-derived", () => {
    const html = text(statsFor());
    expect(html).toContain("有简体标题，没有繁体");
    expect(html).toContain("有简体简介，没有繁体");
  });

  test("coverage is done/total with a percentage, not a bare count", () => {
    // 12350/17518 = 70.49...%, 15917/17518 = 90.86...%
    const html = text(statsFor());
    expect(html).toContain("12,350 / 17,518 (70.5%)");
    expect(html).toContain("15,917 / 17,518 (90.9%)");
  });

  test("the SERP gap is shown as two numbers, not left as an apparent shortfall", () => {
    // 6,422 human-sourced + 5,928 machine-converted = the 12,350 above. Without
    // the second number, "6,422" next to "12,350" reads as 5,928 failures.
    const html = text(statsFor());
    expect(html).toContain("人工来源标题 6,422");
    expect(html).toContain("机器转换 5,928");
    expect(html).toContain("只有这些能进 <title> 和 JSON-LD");
  });

  test("an empty catalogue reads 0.0%, never NaN%", () => {
    const html = text(
      statsFor({ total: 0, titleHant: 0, descHant: 0, serpEligible: 0 }),
    );
    expect(html).toContain("0 / 0 (0.0%)");
    expect(html).not.toContain("NaN");
  });
});

describe("a zero is legible as an all-clear, not as a broken panel", () => {
  test("nothing behind prints the all-clear sentence", () => {
    const html = text(statsFor({ titleBehind: 0, descBehind: 0 }));
    expect(html).toContain("没有落后的行——每条简体都有对应的繁体");
  });

  test("anything behind withdraws the all-clear", () => {
    // The contract's own payload: titles level, two synopses behind. A block
    // that printed "nothing behind" alongside "简介落后 2" would be worse than
    // one that printed nothing at all.
    expect(text(statsFor())).not.toContain("没有落后的行");
    expect(text(statsFor({ titleBehind: 3, descBehind: 0 }))).not.toContain(
      "没有落后的行",
    );
  });

  test("the lede says what a reader sees, so 2 is not read as 2 blank rows", () => {
    expect(text(statsFor())).toContain("繁体读者读到的是简体正文");
  });

  test("a behind column is tinted; a level one is not", () => {
    // The verdict has to survive a glance. Both cards render the same
    // structure, so the only difference between "0" and "2" on screen is the
    // amber the tone prop turns on.
    const AMBER = "#ffb967";
    expect(markup(statsFor({ titleBehind: 0, descBehind: 0 }))).not.toContain(AMBER);
    expect(markup(statsFor())).toContain(AMBER);
  });
});

describe("the trigger button", () => {
  test("is live when no run is in flight", () => {
    expect(markup(statsFor())).not.toContain("disabled");
    expect(text(statsFor())).toContain("立即回填");
  });

  test("is disabled while a backfill is running", () => {
    const html = markup(statsFor({ running: true }));
    expect(html).toContain("disabled");
  });

  test("stays live when nothing is behind", () => {
    // Deliberate: running sooner than the quarterly floor is the button's
    // whole job, and a zero is a claim an operator may want to verify.
    const html = markup(statsFor({ titleBehind: 0, descBehind: 0 }));
    expect(html).not.toContain("disabled");
  });
});

describe("when it last ran", () => {
  test("an idle block reports the age of the last run", () => {
    expect(text(statsFor())).toContain("上次回填 37 分钟前");
  });

  test("a quarterly cadence still reads as a number of days, not 'never'", () => {
    const html = text(statsFor({ lastRunAt: ago(91 * DAY) }));
    expect(html).toContain("上次回填 91 天前");
  });

  test("a job that has never run says so instead of printing a zero age", () => {
    expect(text(statsFor({ lastRunAt: null }))).toContain("上次回填 从未");
  });

  test("a running job says it is running instead of quoting a stale age", () => {
    const html = text(statsFor({ running: true }));
    expect(html).toContain("回填进行中");
    expect(html).not.toContain("上次回填");
  });
});

describe("a failed stats fetch", () => {
  test("says the figures are missing rather than rendering them as zeroes", () => {
    // The endpoint may be absent (rolling deploy) or erroring. A zero in this
    // payload IS the all-clear, so falling back to zeroes would make the panel
    // assert the exact thing it exists to disprove.
    const html = text(null);
    expect(html).toContain("繁体漂移数据读取失败");
    expect(html).not.toContain("没有落后的行");
    expect(html).not.toContain("0 / 0");
  });

  test("still names itself, so the section does not vanish from the page", () => {
    expect(text(null)).toContain("繁体中文漂移");
  });
});

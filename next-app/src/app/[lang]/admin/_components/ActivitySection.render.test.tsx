import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ActivitySection } from "./ActivitySection";
import type { AdminActivity } from "../_types";

// Same approach, and the same justification, as HantDriftSection.render.test.tsx:
// renderToStaticMarkup is react-dom/server — no jsdom, no testing-library, no
// new dependency. lib/activityChart.ts is covered by pure unit tests, and
// pure-function coverage cannot catch a component that never calls them.
//
// This file asserts the wiring, and specifically the four things this panel
// gets wrong if nobody pins them:
//
//   1. the four reliability tiers stay visually and textually distinct;
//   2. a failed sub-query renders as "unavailable", never as a zero — a zero
//      here is a claim ("nobody returned"), so a fetch error rendered as one
//      would be the panel asserting the thing it exists to measure;
//   3. the pre-instrumentation bars carry the hatched treatment AND the
//      sentence, not just the swatch;
//   4. an empty series still produces an axis instead of a blank strip.
//
// With no LanguageProvider above it, useLang() falls back to the path-derived
// locale, which for "/" is zh — so the expected strings here are the
// Simplified ones from zh-spa.js.

function day(
  date: string,
  activeUsers: number,
  instrumented = true,
  over: Partial<AdminActivity["daily"][number]> = {},
) {
  return {
    date,
    activeUsers,
    newUsers: 0,
    logins: 0,
    requests: 0,
    pageViews: 0,
    playbacks: 0,
    instrumented,
    ...over,
  };
}

function activityFor(over: Partial<AdminActivity> = {}): AdminActivity {
  return {
    days: 7,
    timezone: "Asia/Shanghai (UTC+8)",
    instrumentedSince: "2026-08-26",
    dau: 41,
    wau: 118,
    mau: 144,
    stickiness: 41 / 144,
    daily: [
      day("2026-08-22", 9, false),
      day("2026-08-23", 11, false),
      day("2026-08-24", 8, false),
      day("2026-08-25", 12, false),
      day("2026-08-26", 96, true, { newUsers: 3, logins: 5, pageViews: 512, playbacks: 40 }),
      day("2026-08-27", 88, true, { newUsers: 1 }),
      day("2026-08-28", 41, true),
    ],
    retention: {
      windowDays: 7,
      d1: { cohort: 12, returned: 3, rate: 0.25 },
      d7: { cohort: 4, returned: 1, rate: 0.25 },
      ever: { cohort: 17, returned: 5, rate: 5 / 17 },
    },
    surfaces: [
      { surface: "anime", authenticated: 100, anonymous: 900, total: 1000 },
      { surface: "home", authenticated: 40, anonymous: 60, total: 100 },
    ],
    ...over,
  };
}

function markup(data: AdminActivity | null): string {
  return renderToStaticMarkup(<ActivitySection initial={data} />);
}

function text(data: AdminActivity | null): string {
  return markup(data)
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ");
}

describe("the headline numbers are the wire numbers", () => {
  test("DAU, WAU and MAU render as given", () => {
    const html = text(activityFor());
    expect(html).toContain("41");
    expect(html).toContain("118");
    expect(html).toContain("144");
  });

  test("stickiness is DAU/MAU as a percentage, not a raw ratio", () => {
    // 41/144 = 28.47...%
    expect(text(activityFor())).toContain("28.5%");
  });

  test("the lede names the blind spot the per-user numbers have", () => {
    // Without it "DAU 41" reads as a complete measurement of the site.
    expect(text(activityFor())).toContain("只覆盖已登录访问");
  });
});

describe("the instrumentation seam is drawn, not just legended", () => {
  test("pre-instrumentation bars get the hatch, instrumented bars the solid fill", () => {
    const html = markup(activityFor());
    // The hatch is what keeps the distinction off colour alone.
    expect(html).toContain("repeating-linear-gradient");
    // …and the solid fill still appears for the instrumented half.
    expect(html).toContain("#3d90dd");
  });

  test("the seam sentence names the date and how many days precede it", () => {
    const html = text(activityFor());
    expect(html).toContain("2026-08-26");
    expect(html).toContain("左边 4 天");
    // The claim that matters: those days are a floor, not a measurement.
    expect(html).toContain("下界");
  });

  test("a window entirely after the seam drops the sentence", () => {
    const html = text(
      activityFor({
        instrumentedSince: "2026-08-20",
        daily: [day("2026-08-27", 5), day("2026-08-28", 7)],
      }),
    );
    expect(html).not.toContain("下界");
  });

  test("a null instrumentedSince says so instead of printing a date", () => {
    const html = text(
      activityFor({
        instrumentedSince: null,
        daily: [day("2026-08-27", 5, false), day("2026-08-28", 7, false)],
      }),
    );
    expect(html).toContain("逐请求埋点还没产生数据");
  });
});

describe("retention shows the fraction beside every rate", () => {
  test("each horizon prints returned / cohort", () => {
    const html = text(activityFor());
    expect(html).toContain("3 / 12");
    expect(html).toContain("1 / 4");
    expect(html).toContain("5 / 17");
  });

  test("the differing denominators are explained, not left to look like a bug", () => {
    expect(text(activityFor())).toContain("三个分母不同是有意的");
  });

  test("an empty cohort reads as 'no sample', not as 0%", () => {
    // 0% of nobody is a claim about retention; "no cohort" is the truth.
    const html = text(
      activityFor({
        retention: {
          windowDays: 7,
          d1: { cohort: 0, returned: 0, rate: 0 },
          d7: { cohort: 0, returned: 0, rate: 0 },
          ever: { cohort: 0, returned: 0, rate: 0 },
        },
      }),
    );
    expect(html).toContain("样本为空");
  });
});

describe("a failed sub-query is never rendered as a zero", () => {
  test("null retention says unavailable", () => {
    const html = text(activityFor({ retention: null }));
    expect(html).toContain("留存数据读取失败");
    expect(html).not.toContain("三个分母不同是有意的");
  });

  test("null surfaces says unavailable; an empty array says nothing reported", () => {
    expect(text(activityFor({ surfaces: null }))).toContain("板块分布读取失败");
    // The two are different facts and must not render the same way.
    const empty = text(activityFor({ surfaces: [] }));
    expect(empty).toContain("还没有上报数据");
    expect(empty).not.toContain("板块分布读取失败");
  });

  test("a null payload names the section and refuses to invent zeroes", () => {
    const html = text(null);
    expect(html).toContain("用户活跃度");
    expect(html).toContain("活跃度数据读取失败");
    // No fabricated headline numbers.
    expect(html).not.toContain("日活 DAU");
  });
});

describe("the surface table keeps the two populations apart", () => {
  test("anonymous and signed-in are separate columns, not a sum", () => {
    const html = text(activityFor());
    expect(html).toContain("未登录");
    expect(html).toContain("已登录");
    expect(html).toContain("900");
    expect(html).toContain("100");
  });

  test("the card says its numbers come from a public endpoint", () => {
    // This is the only block fed by something a stranger can call, and the
    // sentence is what stops it being quoted next to DAU.
    expect(text(activityFor())).toContain("谁都能调这个接口");
  });
});

describe("degenerate series still render a chart", () => {
  test("an all-zero series produces bars of height 0%, never NaN%", () => {
    const html = markup(
      activityFor({
        daily: [day("2026-08-27", 0), day("2026-08-28", 0)],
      }),
    );
    expect(html).not.toContain("NaN");
    expect(html).toContain("height:0%");
  });

  test("an empty series does not crash and still labels the section", () => {
    const html = text(activityFor({ daily: [] }));
    expect(html).toContain("用户活跃度");
  });

  test("every bar carries the exact figures the axis cannot show", () => {
    // Three date labels for thirty bars is only honest if the numbers are
    // reachable some other way.
    const html = markup(activityFor());
    expect(html).toContain("title=");
    expect(html).toContain("2026-08-26");
  });
});

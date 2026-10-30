import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ADMIN_USERS_DEPTH_EVENT, type AdminUsersDepthDetail } from "@/lib/adminUsers";
import { LanguageProvider } from "@/lib/lang-client";
import type { Lang } from "@/lib/i18n/lang";
import { ActivitySection } from "./ActivitySection";
import { DepthCard } from "./activity/DepthCard";
import type {
  AdminActivityDay,
  AdminActivityDepth,
  AdminActivityPanel,
  AdminActivityWindow,
  AdminCohortWeek,
} from "../_types/activity";

// renderToStaticMarkup is react-dom/server: no jsdom, no testing-library, no
// new dependency (the same harness as HantDriftSection.render.test.tsx). The
// arithmetic is unit-tested in lib/activityChart.test.ts; this file pins the
// wiring, and in particular the rules the panel exists to keep:
//
//   - a delta only against a real base, coloured by direction;
//   - today's bar visibly not over (and never the default readout);
//   - reconstructed numbers marked as floors, in the chart and in text;
//   - no rate for a cohort horizon that is not over;
//   - a failed or malformed fetch renders the error box, never zeroes;
//   - nothing depends on the machine's clock or time zone.
//
// Every number here is synthetic, and the dates sit in 2030. Without a
// LanguageProvider, useLang() falls back to the path-derived locale, which for
// "/" is zh, so the expected strings are the Simplified ones from zh-spa.js.
// Bun resolves a CSS module to its file path, so class names do not exist
// under test: the assertions read text, aria and data-* attributes, and the
// inline styles that carry every per-datum treatment.

const TODAY = "2030-06-12"; // a Wednesday
const AS_OF = "2030-06-12 09:41";

const SYSTEM_TZ = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
afterEach(() => {
  process.env.TZ = SYSTEM_TZ;
});

// ── Fixtures ───────────────────────────────────────────────────────────────

function day(date: string, returning: number, signupDay: number): AdminActivityDay {
  return {
    date,
    returning,
    signupDay,
    requests: (returning + signupDay) * 30,
    logins: 0,
    instrumented: true,
    partial: date === TODAY,
  };
}

const WEEK: AdminActivityDay[] = [
  day("2030-06-06", 3, 2),
  day("2030-06-07", 5, 1),
  day("2030-06-08", 4, 0),
  day("2030-06-09", 6, 3),
  day("2030-06-10", 2, 1),
  day("2030-06-11", 7, 2),
  day("2030-06-12", 3, 2),
];

function win(days: number, over: Partial<AdminActivityWindow> = {}): AdminActivityWindow {
  return {
    days,
    active: 20,
    returning: 12,
    signupOnly: 8,
    prevActive: 22,
    prevReturning: 15,
    prevSignupOnly: 7,
    reconstructed: false,
    prevReconstructed: false,
    ...over,
  };
}

type Four<T> = [T, T, T, T];

function cohort(
  weekStart: string,
  signups: number,
  lastSignup: string | null,
  returned: Four<number>,
  eligible: Four<boolean>,
): AdminCohortWeek {
  const days = [1, 7, 14, 30] as const;
  return {
    weekStart,
    signups,
    lastSignup,
    reconstructed: false,
    horizons: days.map((d, i) => ({ days: d, returned: returned[i], eligible: eligible[i] })),
  };
}

const T = true;
const F = false;

/** Eligibility as the contract computes it for today = 2030-06-12. */
const COHORTS: AdminCohortWeek[] = [
  cohort("2030-06-10", 4, "2030-06-10", [1, 1, 1, 1], [T, F, F, F]),
  cohort("2030-06-03", 6, "2030-06-09", [1, 2, 2, 2], [T, F, F, F]),
  cohort("2030-05-27", 20, "2030-06-02", [2, 5, 6, 6], [T, T, F, F]),
  cohort("2030-05-20", 10, "2030-05-26", [1, 2, 3, 3], [T, T, T, F]),
  cohort("2030-05-13", 8, "2030-05-19", [0, 1, 2, 3], [T, T, T, F]),
  cohort("2030-05-06", 12, "2030-05-12", [3, 3, 4, 5], [T, T, T, T]),
  cohort("2030-04-29", 9, "2030-05-05", [1, 1, 1, 2], [T, T, T, T]),
  cohort("2030-04-22", 7, "2030-04-28", [0, 0, 1, 1], [T, T, T, T]),
  cohort("2030-04-15", 0, null, [0, 0, 0, 0], [F, F, F, F]),
  cohort("2030-04-08", 5, "2030-04-14", [1, 1, 1, 1], [T, T, T, T]),
];

function depth7(over: Partial<AdminActivityDepth> = {}): AdminActivityDepth {
  return {
    days: 7,
    total: 20,
    signupOnly: 8,
    reconstructed: false,
    buckets: [
      { min: 1, max: 1, count: 10 },
      { min: 2, max: 2, count: 6 },
      { min: 3, max: 6, count: 3 },
      { min: 7, max: 7, count: 1 },
    ],
    ...over,
  };
}

/** Instrumented long ago: nothing in view is reconstructed. */
function mature(over: Partial<AdminActivityPanel> = {}): AdminActivityPanel {
  return {
    days: 7,
    timezone: "Asia/Shanghai (UTC+8)",
    today: TODAY,
    asOf: AS_OF,
    instrumentedSince: "2030-01-07",
    todayActive: { active: 5, sameTimeYesterday: 2, sameTimeLastWeek: 4, yesterdayTotal: 9 },
    windows: {
      d7: win(7),
      d30: win(30, { active: 52, returning: 40, signupOnly: 12, prevActive: 50, prevReturning: 40, prevSignupOnly: 10 }),
    },
    signups30: { count: 25, prevCount: 30, returnedAfter: 4, reconstructed: false },
    daily: WEEK,
    depth: depth7(),
    cohorts: COHORTS,
    ...over,
  };
}

/** Instrumented since 2030-06-08: the first two days in view are reconstructed. */
function young(): AdminActivityPanel {
  const base = mature();
  const seam = "2030-06-08";
  return {
    ...base,
    instrumentedSince: seam,
    // Seven days ago predates the seam, so there is no same-time figure for it.
    todayActive: { ...base.todayActive, sameTimeLastWeek: null },
    windows: {
      d7: { ...base.windows.d7, reconstructed: true, prevReconstructed: true },
      d30: { ...base.windows.d30, reconstructed: true, prevReconstructed: true },
    },
    signups30: { ...base.signups30, reconstructed: true },
    daily: base.daily.map((p) => ({ ...p, instrumented: p.date >= seam })),
    depth: { ...base.depth, reconstructed: true },
    // A week is reconstructed when weekStart + 1 day predates the seam.
    cohorts: base.cohorts.map((w) => ({ ...w, reconstructed: w.weekStart < "2030-06-07" })),
  };
}

/** Nothing instrumented yet: every number is a reconstruction. */
function fresh(): AdminActivityPanel {
  const base = mature();
  return {
    ...base,
    instrumentedSince: null,
    todayActive: { ...base.todayActive, sameTimeYesterday: null, sameTimeLastWeek: null },
    windows: {
      d7: { ...base.windows.d7, reconstructed: true, prevReconstructed: true },
      d30: { ...base.windows.d30, reconstructed: true, prevReconstructed: true },
    },
    signups30: { ...base.signups30, reconstructed: true },
    daily: base.daily.map((p) => ({ ...p, instrumented: false })),
    depth: { ...base.depth, reconstructed: true },
    cohorts: base.cohorts.map((w) => ({ ...w, reconstructed: true })),
  };
}

/** The 30-day window: 30 points and the 14–30 depth bucket. */
function thirty(): AdminActivityPanel {
  const daily = Array.from({ length: 30 }, (_, i) => {
    const date = new Date(Date.UTC(2030, 4, 14 + i)).toISOString().slice(0, 10);
    return day(date, (i * 7) % 9, i % 3);
  });
  return mature({
    days: 30,
    daily,
    depth: {
      days: 30,
      total: 52,
      signupOnly: 12,
      reconstructed: false,
      buckets: [
        { min: 1, max: 1, count: 30 },
        { min: 2, max: 2, count: 10 },
        { min: 3, max: 6, count: 8 },
        { min: 7, max: 13, count: 3 },
        { min: 14, max: 30, count: 1 },
      ],
    },
  });
}

// ── Reading the markup ─────────────────────────────────────────────────────

function markup(data: unknown, lang?: Lang): string {
  const panel = <ActivitySection initial={data as AdminActivityPanel | null} />;
  return renderToStaticMarkup(lang ? <LanguageProvider lang={lang}>{panel}</LanguageProvider> : panel);
}

/**
 * Visible text, one space per tag boundary — except around the <b>/<strong>
 * that set a number inside a sentence, which are not word boundaries.
 */
function textOf(html: string): string {
  return html
    .replace(/<\/?(b|strong)>/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ");
}

/** The <div> carrying `marker`, nested divs included. */
function divWith(html: string, marker: string): string {
  const at = html.indexOf(marker);
  if (at < 0) return "";
  const start = html.lastIndexOf("<div", at);
  const tags = /<\/?div\b[^>]*>/g;
  tags.lastIndex = start;
  let depth = 0;
  for (let m = tags.exec(html); m; m = tags.exec(html)) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  return html.slice(start);
}

interface Bar {
  date: string;
  tag: string;
  inner: string;
}

function bars(html: string): Bar[] {
  return [...html.matchAll(/(<button[^>]*data-date="([^"]+)"[^>]*>)([\s\S]*?)<\/button>/g)].map((m) => ({
    tag: m[1],
    date: m[2],
    inner: m[3],
  }));
}

function cells(html: string, state: string): string[] {
  return [...html.matchAll(new RegExp(`<td[^>]*data-state="${state}"[^>]*>[\\s\\S]*?</td>`, "g"))].map((m) => m[0]);
}

const ariaOf = (tag: string) => /aria-label="([^"]*)"/.exec(tag)?.[1] ?? "";

// ── Tests ──────────────────────────────────────────────────────────────────

describe("the KPI cards compare like with like", () => {
  test("up: today against the same moment yesterday, in green", () => {
    const card = divWith(markup(mature()), 'data-kpi="today"');
    expect(card).toContain('data-delta="up"');
    expect(card).toContain("color:#30d158");
    expect(textOf(card)).toContain("今日活跃 5 +3 昨日同一时刻 2 · 上周同一时刻 4");
    expect(textOf(card)).toContain("截至 09:41；昨日全天 9");
  });

  test("down: returning over 7 days against the 7 before, with a real minus, in amber", () => {
    const card = divWith(markup(mature()), 'data-kpi="returning-7"');
    expect(card).toContain('data-delta="down"');
    expect(card).toContain("color:#ff9f0a");
    expect(textOf(card)).toContain("近 7 天回访 12 −3 前 7 天 15");
    expect(textOf(card)).toContain("共 20 人来过，其中 8 人只在注册当天出现");
  });

  test("equal says 持平", () => {
    const card = divWith(markup(mature()), 'data-kpi="returning-30"');
    expect(card).toContain('data-delta="flat"');
    expect(textOf(card)).toContain("近 30 天回访 40 持平 前 30 天 40");
  });

  test("signups compare with the 30 days before and say how many came back", () => {
    const card = textOf(divWith(markup(mature()), 'data-kpi="signups"'));
    expect(card).toContain("近 30 天新注册 25 −5 前 30 天 30");
    expect(card).toContain("之后回来过 4 人");
  });

  test("a null base gets no delta at all, and a dash where its number would be", () => {
    const card = divWith(markup(fresh()), 'data-kpi="today"');
    expect(card).not.toContain("data-delta");
    expect(textOf(card)).toContain("昨日同一时刻 — · 上周同一时刻 —");
  });

  test("a reconstructed window marks its base, and its own figures, as floors", () => {
    const html = markup(young());
    const d7 = textOf(divWith(html, 'data-kpi="returning-7"'));
    expect(d7).toContain("前 7 天 15（含回推）");
    expect(d7).toContain("其中 8 人只在注册当天出现（含回推）");
    // Signups never undercount; only "came back afterwards" can.
    const signups = textOf(divWith(html, 'data-kpi="signups"'));
    expect(signups).toContain("前 30 天 30 ");
    expect(signups).not.toContain("前 30 天 30（含回推）");
    expect(signups).toContain("之后回来过 4 人（含回推）");
    // Mature data carries no marks.
    expect(textOf(markup(mature()))).not.toContain("含回推");
  });
});

describe("today's bar is visibly not over", () => {
  test("only the last bar is partial, half-strength with a dashed edge, and says so", () => {
    const all = bars(markup(mature()));
    expect(all.length).toBe(7);
    const partial = all.filter((b) => b.tag.includes('data-partial="true"'));
    expect(partial.map((b) => b.date)).toEqual([TODAY]);
    expect(partial[0].inner).toContain("opacity:0.5");
    expect(partial[0].inner).toContain("outline:1px dashed #8cc2f0");
    expect(ariaOf(partial[0].tag)).toBe("6月12日：活跃 5，回访 3，注册当天 2（今天还没过完）");
    for (const b of all.slice(0, -1)) expect(b.inner).not.toContain("dashed");
  });

  test("the legend and the axis name it", () => {
    const html = markup(mature());
    expect(textOf(html)).toContain("今天，还没过完");
    expect(textOf(divWith(html, 'data-axis="x"')).trim()).toBe("6/06 今天");
  });

  test("a 90-day axis marks every other week thin, which a narrow chart hides", () => {
    const daily = Array.from({ length: 90 }, (_, i) =>
      day(new Date(Date.UTC(2030, 5, 12 - 89 + i)).toISOString().slice(0, 10), 1, 1),
    );
    const axis = divWith(markup(mature({ days: 90, daily })), 'data-axis="x"');
    const slots = [...axis.matchAll(/<span([^>]*)>([^<]*)<\/span>/g)].map((m) => ({
      thin: m[1].includes('data-thin="true"'),
      text: m[2],
    }));
    expect(slots).toHaveLength(90);
    expect(slots.filter((s) => s.thin).map((s) => s.text)).toEqual(["3/22", "4/05", "4/19", "5/03", "5/17", "5/31"]);
    // What a phone shows: a date every two weeks and 今天, which is never thin.
    expect(slots.filter((s) => s.text && !s.thin).map((s) => s.text)).toEqual([
      "3/15",
      "3/29",
      "4/12",
      "4/26",
      "5/10",
      "5/24",
      "今天",
    ]);
  });

  test("each axis label is centred on its bar, and the thin ones give way below 561px", () => {
    // Read from the stylesheet, comments stripped: a label wider than its
    // slot is only centred by a flex container, never by text-align.
    const sheet = readFileSync(join(import.meta.dir, "activity/DailyChart.module.css"), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    const label = /\.xLabel\s*\{([^}]*)\}/.exec(sheet)?.[1] ?? "";
    expect(label).toMatch(/display:\s*flex/);
    expect(label).toMatch(/justify-content:\s*center/);
    expect(sheet).toMatch(/@media \(max-width: 560px\)\s*\{\s*\.xLabel\[data-thin\]\s*\{\s*visibility:\s*hidden;?\s*\}/);
  });

  test("the readout starts on the last full day, not on today", () => {
    const html = markup(mature());
    expect(html).toContain('data-readout="2030-06-11"');
    const readout = textOf(divWith(html, "data-readout="));
    expect(readout).toContain("6月11日 周二");
    expect(readout).toContain("活跃 9");
    expect(readout).toContain("回访 7");
    expect(readout).toContain("注册当天 2");
    expect(readout).toContain("API 请求 270");
    expect(readout).not.toContain("今天，截至");
  });

  test("the summary averages the days that are over", () => {
    const sum = textOf(divWith(markup(mature()), 'data-summary="daily"'));
    // Full days 6/06–6/11: returning 27 over 6 days, signup day 9 over 6.
    expect(sum).toContain("不含今天，回访日均 4.5 人");
    expect(sum).toContain("注册当天日均 1.5 人");
    expect(sum).toContain("回访最多 7 人（6-11）");
  });

  test("the y axis gets round ticks above the tallest bar", () => {
    // The tallest day is 9 people, so the axis runs 0 / 5 / 10.
    const html = markup(mature());
    const labels = [...html.matchAll(/<span[^>]*style="bottom:([\d.]+)%"[^>]*>(\d+)<\/span>/g)].map((m) => [m[2], m[1]]);
    expect(labels).toEqual([
      ["0", "0"],
      ["5", "50"],
      ["10", "100"],
    ]);
  });
});

describe("reconstructed days are hatched and called floors", () => {
  test("bars before instrumentation are hatched; the rest are solid", () => {
    const all = bars(markup(young()));
    const hatched = all.filter((b) => b.tag.includes('data-reconstructed="true"'));
    expect(hatched.map((b) => b.date)).toEqual(["2030-06-06", "2030-06-07"]);
    for (const b of hatched) {
      expect(b.inner).toContain("repeating-linear-gradient");
      expect(b.inner).not.toContain("background:#3d90dd");
      expect(ariaOf(b.tag)).toEndWith("（回推，只是下界）");
    }
    for (const b of all.filter((x) => !hatched.includes(x))) {
      expect(b.inner).not.toContain("repeating-linear-gradient");
      expect(b.inner).toContain("background:#3d90dd");
      expect(b.inner).toContain("background:#e0559b");
    }
  });

  test("the legend explains the hatch only when one is on screen", () => {
    expect(textOf(markup(young()))).toContain("回推的天，只是下界");
    expect(textOf(markup(mature()))).not.toContain("回推的天，只是下界");
  });

  test("the summary says its averages are floors when they include such days", () => {
    expect(textOf(divWith(markup(young()), 'data-summary="daily"'))).toContain("含回推的天，均值只是下界");
    expect(textOf(divWith(markup(mature()), 'data-summary="daily"'))).not.toContain("均值只是下界");
  });

  test("a reconstructed day in the readout is called a floor", () => {
    const readout = textOf(divWith(markup(fresh()), "data-readout="));
    expect(readout).toContain("回推的数字，只是下界");
  });
});

describe("cohort cells: a rate only for a horizon that is over", () => {
  test("ten weeks, newest first, Monday to Sunday", () => {
    const html = markup(mature());
    const weeks = [...html.matchAll(/<tr data-week="([^"]+)"[^>]*><th scope="row"[^>]*>([^<]*)<\/th>/g)];
    expect(weeks.length).toBe(10);
    expect(weeks[0].slice(1)).toEqual(["2030-06-10", "6/10–6/16"]);
    expect(weeks[2].slice(1)).toEqual(["2030-05-27", "5/27–6/02"]);
  });

  test("the three states, counted", () => {
    const html = markup(mature());
    expect(cells(html, "eligible").length).toBe(26);
    expect(cells(html, "pending").length).toBe(5);
    expect(cells(html, "none").length).toBe(9);
  });

  test("an eligible cell shows the rate, the count and a rate-scaled shade", () => {
    const html = markup(mature());
    const row = /<tr data-week="2030-05-27"[\s\S]*?<\/tr>/.exec(html)?.[0] ?? "";
    const [d1, d7] = cells(row, "eligible");
    expect(textOf(d1)).toContain("10.0% 2 人");
    expect(textOf(d7)).toContain("25.0% 5 人");
    expect(d1).toContain("background-color:rgba(61,144,221,0.287)");
    expect(d7).toContain("background-color:rgba(61,144,221,0.420)");
    expect(d1).toContain('title="5/27 那周注册的 20 人里，2 人在次日回来过"');
  });

  test("the first open horizon is a dashed 已 N 人, later ones a dash, and neither has a rate", () => {
    const html = markup(mature());
    const row = /<tr data-week="2030-06-03"[\s\S]*?<\/tr>/.exec(html)?.[0] ?? "";
    const [pending] = cells(row, "pending");
    expect(textOf(pending).trim()).toBe("已 2 人");
    expect(pending).toContain("border:1px dashed #3a3a4c");
    expect(pending).toContain('title="这周最晚注册的人还没满 7 天，人数还会涨，先不算比例"');
    expect(cells(row, "none").map((c) => textOf(c).trim())).toEqual(["—", "—"]);
    for (const c of [...cells(html, "pending"), ...cells(html, "none")]) {
      expect(c).not.toContain("%");
    }
  });

  test("a week nobody signed up in is dashes, and says why", () => {
    const row = /<tr data-week="2030-04-15"[\s\S]*?<\/tr>/.exec(markup(mature()))?.[0] ?? "";
    expect(cells(row, "none").length).toBe(4);
    expect(row).toContain('title="这周没有人注册"');
  });

  test("reconstructed weeks are hatched and the legend names the seam", () => {
    const html = markup(young());
    const current = /<tr data-week="2030-06-10"[\s\S]*?<\/tr>/.exec(html)?.[0] ?? "";
    const older = /<tr data-week="2030-05-27"[\s\S]*?<\/tr>/.exec(html)?.[0] ?? "";
    expect(current).not.toContain("data-reconstructed");
    expect(current).not.toContain("repeating-linear-gradient");
    expect(older).toContain('data-reconstructed="true"');
    for (const c of [...cells(older, "eligible"), ...cells(older, "pending")]) {
      expect(c).toContain("repeating-linear-gradient");
    }
    expect(cells(older, "eligible")[0]).toContain("（6-08 开始记录前的回访只算得到留过互动痕迹的）");
    const legend = textOf(divWith(html, 'data-card="cohorts"'));
    expect(legend).toContain("还没满期，人数还会涨");
    expect(legend).toContain("含 6-08 开始记录前回推的数据");
  });

  test("with nothing instrumented the legend drops the date; with nothing hatched it drops the entry", () => {
    expect(textOf(markup(fresh()))).toContain("含回推的数据");
    expect(textOf(markup(mature()))).not.toContain("开始记录前回推的数据");
  });
});

describe("depth rows", () => {
  function labels(html: string): string[] {
    return [...divWith(html, 'data-card="depth"').matchAll(/<button[^>]*>\s*<span>([^<]*)<\/span>/g)].map((m) => m[1]);
  }

  test("a 7-day window ends on 7 days exactly", () => {
    const html = markup(mature());
    expect(labels(html)).toEqual(["只来过 1 天", "2 天", "3–6 天", "7 天"]);
    const card = textOf(divWith(html, 'data-card="depth"'));
    expect(card).toContain("近 7 天来过几天 共 20 人");
    expect(card).toContain("10 50.0%");
    expect(card).toContain("只来过 1 天的 10 人里，8 人那一天就是注册当天");
  });

  test("a 30-day window ends on 14–30 days", () => {
    const html = markup(thirty());
    expect(labels(html)).toEqual(["只来过 1 天", "2 天", "3–6 天", "7–13 天", "14–30 天"]);
    expect(textOf(divWith(html, 'data-card="depth"'))).toContain("近 30 天来过几天 共 52 人");
  });

  test("every row is a real button that names its people", () => {
    const card = divWith(markup(mature()), 'data-card="depth"');
    const rows = [...card.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
    expect(rows.length).toBe(4);
    for (const r of rows) expect(r).toContain('type="button"');
    expect(ariaOf(rows[0])).toBe("近 7 天来过 1 天的 10 人，在用户管理里查看");
    expect(ariaOf(rows[2])).toBe("近 7 天来过 3–6 天的 3 人，在用户管理里查看");
    expect(rows[2]).toContain('data-min="3"');
    expect(rows[2]).toContain('data-max="6"');
  });

  test("a reconstructed window marks its total as a floor", () => {
    expect(textOf(divWith(markup(young()), 'data-card="depth"'))).toContain("共 20 人（含回推）");
  });

  test("clicking a row asks the user list for that bucket, then scrolls to it", () => {
    // Render once to capture the element tree with its handlers, then call
    // each row's onClick against a stand-in window and document.
    let tree: ReactNode = null;
    function Capture() {
      tree = DepthCard({ depth: thirty().depth });
      return null;
    }
    renderToStaticMarkup(<Capture />);

    const buttons: ReactElement<{ onClick: () => void }>[] = [];
    const walk = (node: ReactNode) => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) {
        if (node.type === "button") buttons.push(node as ReactElement<{ onClick: () => void }>);
        walk(node.props.children);
      }
    };
    walk(tree);

    const events: AdminUsersDepthDetail[] = [];
    const scrolls: unknown[] = [];
    const target = new EventTarget();
    target.addEventListener(ADMIN_USERS_DEPTH_EVENT, (e) => {
      events.push((e as CustomEvent<AdminUsersDepthDetail>).detail);
    });
    // Bun has no DOM; the stand-ins exist only for these two calls, and the
    // globals are removed again so no other test file sees a `window`.
    const g = globalThis as Record<string, unknown>;
    const had = { window: "window" in g, document: "document" in g };
    const saved = { window: g.window, document: g.document };
    g.window = target;
    g.document = { getElementById: (id: string) => (id === "users" ? { scrollIntoView: (o: unknown) => scrolls.push(o) } : null) };
    try {
      buttons[0].props.onClick();
      buttons[4].props.onClick();
    } finally {
      if (had.window) g.window = saved.window;
      else delete g.window;
      if (had.document) g.document = saved.document;
      else delete g.document;
    }

    expect(buttons.length).toBe(5);
    expect(events).toEqual([
      { days: 30, min: 1, max: 1 },
      { days: 30, min: 14, max: 30 },
    ]);
    expect(scrolls).toEqual([
      { behavior: "smooth", block: "start" },
      { behavior: "smooth", block: "start" },
    ]);
  });
});

describe("the header", () => {
  test("names its scope and the snapshot time in +08", () => {
    expect(textOf(markup(mature()))).toContain("用户活跃度 只统计已登录用户 · 按北京时间切日 · 截至 09:41 ");
    // An RFC 3339 instant is shown in +08 too, never in the machine's zone.
    expect(textOf(markup(mature({ asOf: "2030-06-12T01:41:00Z" })))).toContain("截至 09:41 ");
  });

  test("the window picker presses the window on screen", () => {
    const html = markup(thirty());
    const picker = [...html.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>([^<]*)<\/button>/g)].map((m) => [
      m[2],
      m[1],
    ]);
    expect(picker).toEqual([
      ["7 天", "false"],
      ["30 天", "true"],
      ["90 天", "false"],
    ]);
  });
});

describe("a failed fetch is never rendered as zeroes", () => {
  test("a null payload names the section and shows the error box only", () => {
    const html = textOf(markup(null));
    expect(html).toContain("用户活跃度");
    expect(html).toContain("活跃度数据读取失败");
    expect(html).not.toContain("今日活跃");
    expect(html).not.toMatch(/\d/);
  });

  test("a payload of the old shape is treated as a failure, not drawn", () => {
    const old = { days: 30, timezone: "Asia/Shanghai (UTC+8)", instrumentedSince: null, dau: 3, wau: 9, mau: 20, stickiness: 0.15, daily: [], retention: null };
    const html = textOf(markup(old));
    expect(html).toContain("活跃度数据读取失败");
    expect(html).not.toContain("今日活跃");
  });
});

describe("nothing depends on the clock or the machine's zone", () => {
  test("the same payload renders the same markup in any zone, at any wall time", () => {
    process.env.TZ = "America/Los_Angeles";
    const now = spyOn(Date, "now").mockReturnValue(Date.UTC(2001, 0, 1));
    const west = markup(young());
    process.env.TZ = "Asia/Tokyo";
    now.mockReturnValue(Date.UTC(2044, 11, 31, 23, 59));
    const east = markup(young());
    now.mockRestore();
    expect(east).toBe(west);
  });

  test("an all-zero payload draws zero-height bars, never NaN", () => {
    const zero = mature({
      daily: WEEK.map((p) => ({ ...p, returning: 0, signupDay: 0, requests: 0 })),
      depth: depth7({ total: 0, signupOnly: 0, buckets: depth7().buckets.map((b) => ({ ...b, count: 0 })) }),
    });
    const html = markup(zero);
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("Infinity");
    expect(html).toContain("height:0%");
  });
});

describe("every locale resolves every key", () => {
  for (const lang of ["zh", "zh-Hant", "en"] as const) {
    test(`${lang}: no raw key reaches the page`, () => {
      for (const data of [mature(), young(), fresh(), null]) {
        expect(textOf(markup(data, lang))).not.toContain("admin.activity.");
      }
    });
  }

  test("zh-Hant and en really are translated", () => {
    expect(textOf(markup(mature(), "zh-Hant"))).toContain("近 7 天來過幾天");
    expect(textOf(markup(mature(), "en"))).toContain("Days active in the last 7");
  });
});

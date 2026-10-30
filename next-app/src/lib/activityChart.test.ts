import { afterEach, describe, expect, test } from "bun:test";
import {
  addDays,
  calendarDay,
  clock08,
  cohortCells,
  cohortShade,
  cohortWeekLabel,
  dailySummary,
  depthLabel,
  depthRows,
  formatCount,
  formatDelta,
  formatPercent,
  isActivityPanel,
  monthDayDash,
  monthDaySlash,
  oneDayCount,
  pctOf,
  readoutDefaultIndex,
  showUsersAtDepth,
  xAxisLabels,
  yScale,
} from "@/lib/activityChart";
import { ADMIN_USERS_DEPTH_EVENT, type AdminUsersDepthDetail } from "@/lib/adminUsers";
import type {
  AdminActivityDay,
  AdminActivityDepth,
  AdminActivityPanel,
  AdminCohortWeek,
} from "@/app/[lang]/admin/_types/activity";

// Every figure below is synthetic. Dates sit in 2030 so nobody mistakes a
// fixture for a reading of the live site.

// Some tests below move the process time zone to prove the helpers ignore it.
// Bun keeps a runtime TZ even after `delete process.env.TZ`, and every test
// file shares the process, so the resolved zone is put back explicitly.
const SYSTEM_TZ = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
afterEach(() => {
  process.env.TZ = SYSTEM_TZ;
});

function day(date: string, returning: number, signupDay: number, over: Partial<AdminActivityDay> = {}): AdminActivityDay {
  return { date, returning, signupDay, requests: 0, logins: 0, instrumented: true, partial: false, ...over };
}

/** `n` consecutive days ending on 2030-06-12, the last one partial (today). */
function series(n: number): AdminActivityDay[] {
  return Array.from({ length: n }, (_, i) => {
    const date = addDays("2030-06-12", i - (n - 1)) ?? "";
    return day(date, 1, 1, { partial: i === n - 1 });
  });
}

function week(over: Partial<AdminCohortWeek> = {}): AdminCohortWeek {
  return {
    weekStart: "2030-05-27",
    signups: 20,
    lastSignup: "2030-06-02",
    reconstructed: false,
    horizons: [
      { days: 1, returned: 2, eligible: true },
      { days: 7, returned: 5, eligible: true },
      { days: 14, returned: 6, eligible: false },
      { days: 30, returned: 6, eligible: false },
    ],
    ...over,
  };
}

describe("calendar days are read as calendar days", () => {
  test("splits a YYYY-MM-DD string and names its weekday (0 = Sunday)", () => {
    expect(calendarDay("2030-06-12")).toEqual({ year: 2030, month: 6, day: 12, weekday: 3 });
    expect(calendarDay("2030-06-09")?.weekday).toBe(0);
  });

  test("rejects strings that are not a real day", () => {
    expect(calendarDay("2030-02-30")).toBeNull();
    expect(calendarDay("2030-6-1")).toBeNull();
    expect(calendarDay("2030-06-12T00:00:00Z")).toBeNull();
    expect(calendarDay("")).toBeNull();
  });

  test("the weekday does not depend on the machine's time zone", () => {
    // `new Date("2030-06-12")` is midnight UTC, which is still the 11th in
    // America — the classic one-day slip. Calendar arithmetic must not see it.
    process.env.TZ = "America/Los_Angeles";
    const west = calendarDay("2030-06-12");
    process.env.TZ = "Pacific/Kiritimati";
    const east = calendarDay("2030-06-12");
    expect(west).toEqual(east);
    expect(west?.weekday).toBe(3);
  });

  test("addDays crosses month and year ends", () => {
    expect(addDays("2030-12-29", 6)).toBe("2031-01-04");
    expect(addDays("2030-03-01", -1)).toBe("2030-02-28");
    expect(addDays("nonsense", 1)).toBeNull();
  });
});

describe("short date labels", () => {
  test("month unpadded, day padded, in the two separators the canvas uses", () => {
    expect(monthDaySlash("2030-06-03")).toBe("6/03");
    expect(monthDaySlash("2030-11-30")).toBe("11/30");
    expect(monthDayDash("2030-06-03")).toBe("6-03");
  });

  test("odd input passes through so a payload problem stays visible", () => {
    expect(monthDaySlash("today")).toBe("today");
    expect(monthDayDash("")).toBe("");
  });

  test("a cohort week is Monday to Sunday, across a year end too", () => {
    expect(cohortWeekLabel("2030-04-29")).toBe("4/29–5/05");
    expect(cohortWeekLabel("2030-12-30")).toBe("12/30–1/05");
  });
});

describe("clock08 reads the snapshot time in +08", () => {
  test("the wire format is already +08 wall time and is taken as is", () => {
    expect(clock08("2030-06-12 09:41")).toEqual({ date: "2030-06-12", time: "09:41" });
  });

  test("an instant with a zone is moved to +08 with fixed-offset arithmetic", () => {
    // 16:30 UTC is 00:30 the next day in Beijing.
    expect(clock08("2030-06-11T16:30:00Z")).toEqual({ date: "2030-06-12", time: "00:30" });
    expect(clock08("2030-06-12T09:41:00+08:00")).toEqual({ date: "2030-06-12", time: "09:41" });
    expect(clock08("2030-06-11T20:41:00-05:00")).toEqual({ date: "2030-06-12", time: "09:41" });
  });

  test("the answer is the same in every browser time zone", () => {
    process.env.TZ = "America/New_York";
    const ny = clock08("2030-06-11T16:30:00Z");
    process.env.TZ = "Asia/Kolkata";
    expect(clock08("2030-06-11T16:30:00Z")).toEqual(ny);
  });

  test("anything else is null rather than a guess", () => {
    expect(clock08("2030-06-12")).toBeNull();
    expect(clock08("2030-06-12 25:00")).toBeNull();
    expect(clock08("soon")).toBeNull();
  });
});

describe("formatCount", () => {
  test("groups thousands", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(1234567)).toBe("1,234,567");
  });

  test("a non-number is a dash, never a zero", () => {
    expect(formatCount(Number.NaN)).toBe("—");
    expect(formatCount(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("formatDelta", () => {
  test("up is +N", () => {
    expect(formatDelta(12, 9, "持平")).toEqual({ kind: "up", text: "+3" });
  });

  test("down is a real minus sign, not a hyphen", () => {
    expect(formatDelta(9, 12, "持平")).toEqual({ kind: "down", text: "−3" });
  });

  test("equal says so in words", () => {
    expect(formatDelta(7, 7, "持平")).toEqual({ kind: "flat", text: "持平" });
  });

  test("no base, no delta", () => {
    expect(formatDelta(7, null, "持平")).toBeNull();
    expect(formatDelta(7, Number.NaN, "持平")).toBeNull();
  });

  test("large differences are grouped like every other count", () => {
    expect(formatDelta(3500, 1000, "=")?.text).toBe("+2,500");
  });
});

describe("yScale picks a few round ticks above the data", () => {
  const cases: Array<[number, number, number[]]> = [
    [0, 1, [0]],
    [1, 1, [0, 1]],
    [3, 3, [0, 1, 2, 3]],
    [5, 6, [0, 2, 4, 6]],
    [7, 10, [0, 5, 10]],
    [13, 15, [0, 5, 10, 15]],
    [54, 60, [0, 20, 40, 60]],
    [61, 75, [0, 25, 50, 75]],
    [150, 150, [0, 50, 100, 150]],
    [1800, 2000, [0, 1000, 2000]],
  ];
  for (const [max, top, ticks] of cases) {
    test(`max ${max} → top ${top}`, () => {
      expect(yScale(max)).toEqual({ top, ticks });
    });
  }

  test("every scale covers its max with at most four evenly spaced ticks", () => {
    for (let max = 1; max <= 500; max++) {
      const { top, ticks } = yScale(max);
      expect(top).toBeGreaterThanOrEqual(max);
      expect(ticks[0]).toBe(0);
      expect(ticks[ticks.length - 1]).toBe(top);
      expect(ticks.length).toBeLessThanOrEqual(4);
      expect(new Set(ticks.slice(1).map((v, i) => v - ticks[i])).size).toBe(1);
    }
  });

  test("hostile input does not produce NaN", () => {
    expect(yScale(Number.NaN)).toEqual({ top: 1, ticks: [0] });
    expect(yScale(-4)).toEqual({ top: 1, ticks: [0] });
  });
});

describe("pctOf", () => {
  test("scales and clamps", () => {
    expect(pctOf(15, 60)).toBe(25);
    expect(pctOf(90, 60)).toBe(100);
    expect(pctOf(-1, 60)).toBe(0);
  });

  test("never NaN", () => {
    expect(pctOf(5, 0)).toBe(0);
    expect(pctOf(Number.NaN, 10)).toBe(0);
  });
});

describe("xAxisLabels", () => {
  const shown = (labels: ReturnType<typeof xAxisLabels>) =>
    labels.flatMap((l, i) => (l ? [[i, l.kind === "today" ? "today" : l.text]] : []));

  test("7 days: the first day and today", () => {
    expect(shown(xAxisLabels(series(7)))).toEqual([
      [0, "6/06"],
      [6, "today"],
    ]);
  });

  test("30 days: every 7th day, minus the one that would crowd today", () => {
    expect(shown(xAxisLabels(series(30)))).toEqual([
      [0, "5/14"],
      [7, "5/21"],
      [14, "5/28"],
      [21, "6/04"],
      [29, "today"],
    ]);
  });

  test("90 days: every 7th day survives when today is far enough away", () => {
    const labels = shown(xAxisLabels(series(90)));
    expect(labels.length).toBe(14);
    expect(labels[12]).toEqual([84, "6/07"]);
    expect(labels[13]).toEqual([89, "today"]);
  });

  test("no partial day, no today label", () => {
    const done = series(7).map((p) => ({ ...p, partial: false }));
    expect(shown(xAxisLabels(done))).toEqual([[0, "6/06"]]);
  });
});

describe("readoutDefaultIndex", () => {
  test("is the last full day, not today", () => {
    expect(readoutDefaultIndex(series(30))).toBe(28);
  });

  test("falls back to the last point, then to nothing", () => {
    expect(readoutDefaultIndex([day("2030-06-12", 1, 0, { partial: true })])).toBe(0);
    expect(readoutDefaultIndex([])).toBe(-1);
  });
});

describe("dailySummary", () => {
  const points = [
    day("2030-06-08", 4, 2),
    day("2030-06-09", 6, 0),
    day("2030-06-10", 2, 3),
    day("2030-06-11", 6, 1),
    day("2030-06-12", 40, 40, { partial: true }),
  ];

  test("averages the full days only", () => {
    const s = dailySummary(points);
    expect(s?.days).toBe(4);
    expect(s?.avgReturning).toBe(4.5);
    expect(s?.avgSignupDay).toBe(1.5);
  });

  test("the peak is the most recent day on a tie, never today", () => {
    expect(dailySummary(points)?.peak).toEqual({ returning: 6, date: "2030-06-11" });
  });

  test("flags a range that reaches back before instrumentation", () => {
    expect(dailySummary(points)?.reconstructed).toBe(false);
    const older = [day("2030-06-07", 1, 1, { instrumented: false }), ...points];
    expect(dailySummary(older)?.reconstructed).toBe(true);
  });

  test("a reconstructed today does not flag the full days", () => {
    const todayOnly = points.map((p) => (p.partial ? { ...p, instrumented: false } : p));
    expect(dailySummary(todayOnly)?.reconstructed).toBe(false);
  });

  test("nothing to average is null", () => {
    expect(dailySummary([day("2030-06-12", 3, 1, { partial: true })])).toBeNull();
    expect(dailySummary([])).toBeNull();
  });
});

describe("depth labels", () => {
  test("the first bucket, a single day, and a range", () => {
    expect(depthLabel({ min: 1, max: 1 })).toEqual({ kind: "onlyOne" });
    expect(depthLabel({ min: 2, max: 2 })).toEqual({ kind: "exact", days: 2 });
    expect(depthLabel({ min: 7, max: 7 })).toEqual({ kind: "exact", days: 7 });
    expect(depthLabel({ min: 3, max: 6 })).toEqual({ kind: "range", min: 3, max: 6 });
  });

  function depthOf(days: number, buckets: Array<[number, number, number]>): AdminActivityDepth {
    const total = buckets.reduce((a, [, , c]) => a + c, 0);
    return {
      days,
      total,
      signupOnly: 0,
      reconstructed: false,
      buckets: buckets.map(([min, max, count]) => ({ min, max, count })),
    };
  }

  test("a 7-day window ends on 7 exactly", () => {
    const rows = depthRows(depthOf(7, [[1, 1, 8], [2, 2, 4], [3, 6, 2], [7, 7, 2]]));
    expect(rows.map((r) => r.label)).toEqual([
      { kind: "onlyOne" },
      { kind: "exact", days: 2 },
      { kind: "range", min: 3, max: 6 },
      { kind: "exact", days: 7 },
    ]);
    expect(rows.map((r) => r.share)).toEqual(["50.0%", "25.0%", "12.5%", "12.5%"]);
  });

  test("a 30-day window ends on 14–30, bars scaled to the largest bucket", () => {
    const rows = depthRows(depthOf(30, [[1, 1, 3], [2, 2, 12], [3, 6, 6], [7, 13, 2], [14, 30, 1]]));
    expect(rows[4].label).toEqual({ kind: "range", min: 14, max: 30 });
    const expected = [25, 100, 50, 16.667, 8.333];
    rows.forEach((r, i) => expect(r.barPct).toBeCloseTo(expected[i], 2));
  });

  test("an empty window renders zero bars and zero shares, not NaN", () => {
    const rows = depthRows(depthOf(30, [[1, 1, 0], [2, 2, 0]]));
    expect(rows.map((r) => [r.barPct, r.share])).toEqual([
      [0, "0.0%"],
      [0, "0.0%"],
    ]);
  });

  test("oneDayCount reads the 1-day bucket", () => {
    expect(oneDayCount(depthOf(7, [[1, 1, 8], [2, 2, 4]]))).toBe(8);
    expect(oneDayCount(depthOf(7, [[2, 2, 4]]))).toBe(0);
  });
});

describe("cohortCells", () => {
  test("eligible horizons carry a rate; the first open one is pending; the rest are none", () => {
    expect(cohortCells(week())).toEqual([
      { state: "eligible", days: 1, returned: 2, rate: 0.1 },
      { state: "eligible", days: 7, returned: 5, rate: 0.25 },
      { state: "pending", days: 14, returned: 6 },
      { state: "none", days: 30 },
    ]);
  });

  test("a non-eligible horizon never gets a rate, whatever the order of flags", () => {
    const odd = week({
      horizons: [
        { days: 1, returned: 2, eligible: false },
        { days: 7, returned: 5, eligible: true },
        { days: 14, returned: 6, eligible: false },
        { days: 30, returned: 6, eligible: true },
      ],
    });
    const cells = cohortCells(odd);
    expect(cells.map((c) => c.state)).toEqual(["pending", "eligible", "none", "eligible"]);
    for (const c of cells) {
      if (c.state !== "eligible") expect("rate" in c).toBe(false);
    }
  });

  test("a week nobody signed up in is all none", () => {
    const empty = week({
      signups: 0,
      lastSignup: null,
      horizons: [1, 7, 14, 30].map((d) => ({ days: d as 1 | 7 | 14 | 30, returned: 0, eligible: false })),
    });
    expect(cohortCells(empty).map((c) => c.state)).toEqual(["none", "none", "none", "none"]);
  });

  test("cells follow the 1/7/14/30 columns even if the payload omits or reorders one", () => {
    const cells = cohortCells(
      week({
        horizons: [
          { days: 7, returned: 5, eligible: true },
          { days: 1, returned: 2, eligible: true },
        ],
      }),
    );
    expect(cells.map((c) => [c.days, c.state])).toEqual([
      [1, "eligible"],
      [7, "eligible"],
      [14, "none"],
      [30, "none"],
    ]);
  });
});

describe("cohortShade", () => {
  test("rises with the rate and caps", () => {
    expect(cohortShade(0)).toBeCloseTo(0.06, 6);
    expect(cohortShade(0.15)).toBeCloseTo(0.4, 6);
    expect(cohortShade(0.5)).toBe(0.42);
    expect(cohortShade(Number.NaN)).toBeCloseTo(0.06, 6);
  });
});

describe("formatPercent", () => {
  test("one decimal, clamped", () => {
    expect(formatPercent(0.0526)).toBe("5.3%");
    expect(formatPercent(1.4)).toBe("100.0%");
    expect(formatPercent(Number.NaN)).toBe("0.0%");
  });
});

describe("showUsersAtDepth", () => {
  test("announces the bucket, then scrolls the user list into view", () => {
    const order: string[] = [];
    const target = new EventTarget();
    let received: AdminUsersDepthDetail | null = null;
    target.addEventListener(ADMIN_USERS_DEPTH_EVENT, (e) => {
      order.push("event");
      received = (e as CustomEvent<AdminUsersDepthDetail>).detail;
    });
    let scrolled: ScrollIntoViewOptions | undefined;
    const doc = {
      getElementById: (id: string) =>
        id === "users"
          ? {
              scrollIntoView: (opts?: ScrollIntoViewOptions) => {
                order.push("scroll");
                scrolled = opts;
              },
            }
          : null,
    };

    showUsersAtDepth({ days: 30, min: 3, max: 6 }, { target, doc });

    expect(ADMIN_USERS_DEPTH_EVENT).toBe("admin:users-depth");
    expect(received).toEqual({ days: 30, min: 3, max: 6 });
    expect(scrolled).toEqual({ behavior: "smooth", block: "start" });
    expect(order).toEqual(["event", "scroll"]);
  });

  test("does nothing worse than dispatch when the list is not on the page", () => {
    const target = new EventTarget();
    expect(() =>
      showUsersAtDepth({ days: 7, min: 1, max: 1 }, { target, doc: { getElementById: () => null } }),
    ).not.toThrow();
  });
});

describe("isActivityPanel guards the wire", () => {
  function panel(): AdminActivityPanel {
    const w = {
      days: 7,
      active: 3,
      returning: 1,
      signupOnly: 2,
      prevActive: 2,
      prevReturning: 1,
      prevSignupOnly: 1,
      reconstructed: false,
      prevReconstructed: false,
    };
    return {
      days: 7,
      timezone: "Asia/Shanghai (UTC+8)",
      today: "2030-06-12",
      asOf: "2030-06-12 09:41",
      instrumentedSince: "2030-01-02",
      todayActive: { active: 1, sameTimeYesterday: null, sameTimeLastWeek: 2, yesterdayTotal: 3 },
      windows: { d7: w, d30: { ...w, days: 30 } },
      signups30: { count: 4, prevCount: 5, returnedAfter: 1, reconstructed: false },
      daily: series(7),
      depth: { days: 7, total: 3, signupOnly: 2, reconstructed: false, buckets: [{ min: 1, max: 1, count: 3 }] },
      cohorts: [week()],
    };
  }

  test("accepts the contract's shape", () => {
    expect(isActivityPanel(panel())).toBe(true);
  });

  test("rejects nothing, and the old dau/wau/mau payload", () => {
    expect(isActivityPanel(null)).toBe(false);
    expect(isActivityPanel(undefined)).toBe(false);
    expect(
      isActivityPanel({ days: 30, timezone: "x", instrumentedSince: null, dau: 1, wau: 2, mau: 3, daily: [], retention: null }),
    ).toBe(false);
  });

  test("rejects a payload with one malformed part", () => {
    const noWindows = { ...panel(), windows: { d7: panel().windows.d7 } };
    expect(isActivityPanel(noWindows)).toBe(false);
    const badDay = { ...panel(), daily: [...series(6), { date: "2030-06-12", returning: "4" }] };
    expect(isActivityPanel(badDay)).toBe(false);
    const badCohort = { ...panel(), cohorts: [{ ...week(), horizons: null }] };
    expect(isActivityPanel(badCohort)).toBe(false);
  });
});

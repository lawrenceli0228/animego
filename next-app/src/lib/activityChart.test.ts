import { describe, expect, test } from "bun:test";
import {
  axisTickIndices,
  barHeightPct,
  formatRate,
  instrumentationSplit,
  seriesMax,
  shortDate,
  type ActivityDayPoint,
} from "@/lib/activityChart";

function point(date: string, activeUsers: number, instrumented = true): ActivityDayPoint {
  return {
    date,
    activeUsers,
    newUsers: 0,
    logins: 0,
    requests: 0,
    pageViews: 0,
    playbacks: 0,
    instrumented,
  };
}

describe("seriesMax", () => {
  test("returns the largest value", () => {
    expect(seriesMax([3, 9, 1])).toBe(9);
  });

  // The floor is the whole reason this function exists. An all-zero series is
  // the normal state of a fresh deployment, and dividing by its max would make
  // every bar NaN% tall — which the browser drops silently, so the chart would
  // render as an empty strip that looks exactly like a working chart of a
  // quiet week.
  test("floors at 1 so an empty series never divides by zero", () => {
    expect(seriesMax([])).toBe(1);
    expect(seriesMax([0, 0, 0])).toBe(1);
  });

  test("ignores non-finite values rather than propagating them", () => {
    expect(seriesMax([2, Number.NaN, 5, Number.POSITIVE_INFINITY])).toBe(5);
  });
});

describe("barHeightPct", () => {
  test("scales against the maximum", () => {
    expect(barHeightPct(5, 10)).toBe(50);
    expect(barHeightPct(10, 10)).toBe(100);
  });

  test("zero and below render as no bar", () => {
    expect(barHeightPct(0, 10)).toBe(0);
    // Not producible by the API, but a cached payload from a future schema
    // might; a negative must not draw a bar growing down through the axis.
    expect(barHeightPct(-4, 10)).toBe(0);
  });

  test("never returns NaN or exceeds the plot", () => {
    expect(barHeightPct(5, 0)).toBe(0);
    expect(barHeightPct(Number.NaN, 10)).toBe(0);
    expect(barHeightPct(20, 10)).toBe(100);
  });
});

describe("axisTickIndices", () => {
  test("labels first, middle and last", () => {
    expect(axisTickIndices(30)).toEqual([0, 14, 29]);
  });

  // A one- or two-point series would otherwise print the same date two or
  // three times side by side.
  test("de-duplicates on short series", () => {
    expect(axisTickIndices(1)).toEqual([0]);
    expect(axisTickIndices(2)).toEqual([0, 1]);
    expect(axisTickIndices(3)).toEqual([0, 1, 2]);
  });

  test("is empty for an empty series", () => {
    expect(axisTickIndices(0)).toEqual([]);
  });
});

describe("shortDate", () => {
  test("drops the year", () => {
    expect(shortDate("2026-08-27")).toBe("08-27");
  });

  // Passing an odd string through unchanged makes a payload problem visible on
  // the axis instead of hiding it behind a plausible-looking date.
  test("passes non-ISO input through untouched", () => {
    expect(shortDate("today")).toBe("today");
    expect(shortDate("")).toBe("");
  });
});

describe("formatRate", () => {
  test("renders one decimal", () => {
    expect(formatRate(0.125)).toBe("12.5%");
    expect(formatRate(1)).toBe("100.0%");
  });

  test("an empty cohort reads as zero, not NaN", () => {
    expect(formatRate(0)).toBe("0.0%");
    expect(formatRate(Number.NaN)).toBe("0.0%");
  });

  test("clamps above one", () => {
    expect(formatRate(1.4)).toBe("100.0%");
  });
});

describe("instrumentationSplit", () => {
  test("counts the two evidence tiers in the window", () => {
    const points = [
      point("2026-08-24", 1, false),
      point("2026-08-25", 2, false),
      point("2026-08-26", 3, true),
    ];
    expect(instrumentationSplit(points)).toEqual({ reconstructed: 2, instrumented: 1 });
  });

  test("handles a window entirely on one side of the seam", () => {
    expect(instrumentationSplit([point("2026-08-26", 1, true)])).toEqual({
      reconstructed: 0,
      instrumented: 1,
    });
    expect(instrumentationSplit([])).toEqual({ reconstructed: 0, instrumented: 0 });
  });
});

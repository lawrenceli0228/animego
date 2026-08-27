// The arithmetic behind the admin activity chart, kept out of the component so
// it can be checked without a DOM.
//
// Everything here is deliberately small and total: no NaN, no Infinity, no
// division that can produce one. A chart helper that returns NaN does not
// throw — it renders a bar of height "NaN%", which the browser drops silently,
// and the day simply vanishes from the axis. That failure is invisible in
// review and looks exactly like a quiet day.

/** One day of the activity series, as GET /api/admin/activity returns it. */
export interface ActivityDayPoint {
  date: string;
  activeUsers: number;
  newUsers: number;
  logins: number;
  requests: number;
  pageViews: number;
  playbacks: number;
  /**
   * False for days whose numbers came from the historical reconstruction
   * rather than from per-request recording. The flag is computed server-side
   * and travels with the point, so the browser never has to compare date
   * strings against a boundary and get the edge wrong.
   */
  instrumented: boolean;
}

/**
 * The denominator for a bar's height.
 *
 * Floors at 1 so an all-zero series divides by 1 rather than by 0 — every bar
 * is then honestly 0% tall instead of NaN.
 *
 * Uses the series maximum rather than a rounded "nice" ceiling on purpose: the
 * tallest bar filling the plot is what makes a thirty-bar strip readable at
 * this height, and the exact values are on the hover and in the summary line.
 */
export function seriesMax(values: readonly number[]): number {
  let max = 0;
  for (const v of values) {
    if (Number.isFinite(v) && v > max) max = v;
  }
  return max > 0 ? max : 1;
}

/**
 * A bar's height as a percentage of the plot.
 *
 * Clamped to [0, 100] and total over hostile input: a negative count (which
 * the API cannot produce, but a stale cached payload from a future schema
 * might) renders as an empty slot rather than as a bar growing downward
 * through the axis.
 */
export function barHeightPct(value: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (!Number.isFinite(max) || max <= 0) return 0;
  const pct = (value / max) * 100;
  if (pct < 0) return 0;
  return pct > 100 ? 100 : pct;
}

/**
 * Which x positions get a printed date.
 *
 * Three at most — first, middle, last. A label under every bar is unreadable
 * at thirty days and illegible at ninety; the per-bar hover carries the exact
 * date for anything in between.
 *
 * Returns indices rather than strings so the caller decides the format, and
 * de-duplicates so a one- or two-point series does not print the same date
 * twice.
 */
export function axisTickIndices(length: number): number[] {
  if (length <= 0) return [];
  if (length === 1) return [0];
  const middle = Math.floor((length - 1) / 2);
  return [...new Set([0, middle, length - 1])];
}

/**
 * "2026-08-27" → "08-27".
 *
 * Month and day only: every tick on the axis is inside a ninety-day window, so
 * the year is the same on all of them and printing it three times spends the
 * width that makes the labels fit.
 *
 * Non-ISO input passes through unchanged rather than being coerced — a
 * surprising string on the axis is a visible prompt to look at the payload,
 * whereas a silently reformatted one is not.
 */
export function shortDate(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso.slice(5) : iso;
}

/**
 * A rate (0..1) as a percentage string with one decimal.
 *
 * One decimal, not zero, because at this scale a cohort of eleven moves the
 * rate in steps of about nine points and rounding to whole numbers makes two
 * genuinely different weeks print the same figure.
 */
export function formatRate(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return "0.0%";
  const clamped = rate > 1 ? 1 : rate;
  return `${(clamped * 100).toFixed(1)}%`;
}

/**
 * How much of the visible window predates instrumentation.
 *
 * The caller uses this to decide whether the "these bars are reconstructed"
 * explanation is worth the vertical space: on a window entirely after the
 * seam it is noise, and on one entirely before it the whole chart needs the
 * caveat rather than a legend swatch.
 */
export function instrumentationSplit(points: readonly ActivityDayPoint[]): {
  reconstructed: number;
  instrumented: number;
} {
  let reconstructed = 0;
  for (const p of points) {
    if (!p.instrumented) reconstructed += 1;
  }
  return { reconstructed, instrumented: points.length - reconstructed };
}

/**
 * A surface's share of total traffic, as a percentage of the largest surface.
 *
 * Relative to the LARGEST rather than to the sum, because the bars are a
 * ranking aid next to the numbers, not a part-to-whole claim. Shares of a sum
 * would need to add to 100 to be honest, and the table is already truncated to
 * the surfaces that have data.
 */
export function surfaceBarPct(total: number, max: number): number {
  return barHeightPct(total, max);
}

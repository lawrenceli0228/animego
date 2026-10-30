// The arithmetic behind the admin activity panel, kept out of the components
// so it can be checked without a DOM.
//
// Three rules hold everywhere in this file:
//
//   - Total functions. No NaN, no Infinity, no division that can produce one.
//     A helper that returns NaN does not throw: it renders a bar of height
//     "NaN%", which the browser drops silently, and the day simply vanishes.
//   - No clock. Nothing here reads Date.now() or the browser's time zone.
//     "Today" and "now" come from the payload (`today`, `asOf`), so the server
//     render and the hydrated page print the same text, in every zone.
//   - Calendar strings stay calendar strings. A YYYY-MM-DD reporting day is
//     split into numbers and handed to Date.UTC; it is never given to
//     `new Date(str)`, which reads it as UTC midnight and slips a day west of
//     Greenwich.
//
// The terms (returning, signup-only, reconstructed, eligible) are defined in
// the header of admin/_types/activity.ts.

import type {
  AdminActivityDay,
  AdminActivityDepth,
  AdminActivityPanel,
  AdminCohortWeek,
  AdminDepthBucket,
} from "@/app/[lang]/admin/_types/activity";
import { ADMIN_USERS_DEPTH_EVENT, type AdminUsersDepthDetail } from "@/lib/adminUsers";

const DAY_MS = 86_400_000;
/** Asia/Shanghai: a fixed +08, no daylight saving. */
const OFFSET_08_MS = 8 * 3_600_000;

// ── Calendar days ──────────────────────────────────────────────────────────

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface CalendarDay {
  year: number;
  /** 1–12. */
  month: number;
  day: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
}

/** "2030-06-12" → its parts, or null for anything that is not a real day. */
export function calendarDay(date: string): CalendarDay | null {
  const m = YMD.exec(date);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const at = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC rolls 2030-02-30 over into March; a real day survives the trip.
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day, weekday: at.getUTCDay() };
}

function ymd(ms: number): string {
  const at = new Date(ms);
  const mm = String(at.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(at.getUTCDate()).padStart(2, "0");
  return `${at.getUTCFullYear()}-${mm}-${dd}`;
}

/** The calendar day `n` days after `date` (negative goes back). */
export function addDays(date: string, n: number): string | null {
  const c = calendarDay(date);
  if (!c || !Number.isFinite(n)) return null;
  return ymd(Date.UTC(c.year, c.month - 1, c.day) + Math.trunc(n) * DAY_MS);
}

function monthDay(date: string, separator: string): string {
  const c = calendarDay(date);
  if (!c) return date;
  return `${c.month}${separator}${String(c.day).padStart(2, "0")}`;
}

/**
 * "2030-06-03" → "6/03": the chart's x axis and the cohort weeks.
 *
 * Month unpadded, day padded, no year — every label on this panel sits within
 * a few months of today. Odd input passes through unchanged, so a payload
 * problem shows up on screen instead of hiding behind a plausible date.
 */
export function monthDaySlash(date: string): string {
  return monthDay(date, "/");
}

/** "2030-06-03" → "6-03": dates inside sentences (the snapshot time, the peak day). */
export function monthDayDash(date: string): string {
  return monthDay(date, "-");
}

/** A Monday-start signup week: "4/29–5/05". */
export function cohortWeekLabel(weekStart: string): string {
  const end = addDays(weekStart, 6);
  return end ? `${monthDaySlash(weekStart)}–${monthDaySlash(end)}` : weekStart;
}

// ── The snapshot clock ─────────────────────────────────────────────────────

const WALL_08 = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

export interface Clock08 {
  /** YYYY-MM-DD in +08. */
  date: string;
  /** HH:mm in +08. */
  time: string;
}

/**
 * The snapshot time, as a +08 day and HH:mm.
 *
 * The wire sends `asOf` as "YYYY-MM-DD HH:mm" already in +08, which is taken
 * as is. An RFC 3339 instant (with Z or an offset) is moved to +08 by adding
 * eight hours and reading the UTC fields — fixed-offset arithmetic, never the
 * browser's zone. Anything else is null, not a guess.
 */
export function clock08(value: string): Clock08 | null {
  const wall = WALL_08.exec(value);
  if (wall) {
    const [, date, hh, mm] = wall;
    if (!calendarDay(date) || Number(hh) > 23 || Number(mm) > 59) return null;
    return { date, time: `${hh}:${mm}` };
  }
  if (!INSTANT.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const at = new Date(ms + OFFSET_08_MS);
  const hh = String(at.getUTCHours()).padStart(2, "0");
  const mm = String(at.getUTCMinutes()).padStart(2, "0");
  return { date: ymd(ms + OFFSET_08_MS), time: `${hh}:${mm}` };
}

// ── Numbers ────────────────────────────────────────────────────────────────

const COUNT_FORMAT = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });

/** A head count with thousands grouping; a non-number is a dash, never "0". */
export function formatCount(n: number): string {
  return Number.isFinite(n) ? COUNT_FORMAT.format(Math.round(n)) : "—";
}

/** One decimal: the daily averages. */
export function formatOneDecimal(n: number): string {
  return Number.isFinite(n) ? n.toFixed(1) : "—";
}

/** A fraction (0..1) as a one-decimal percentage, clamped. */
export function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction) || fraction <= 0) return "0.0%";
  return `${(Math.min(fraction, 1) * 100).toFixed(1)}%`;
}

export type DeltaKind = "up" | "down" | "flat";

export interface Delta {
  kind: DeltaKind;
  text: string;
}

/**
 * A KPI's change against its base: "+N", "−N" (U+2212, not a hyphen), or the
 * flat label. Null when there is no base to compare with — no delta at all is
 * honest; "+N against nothing" is not.
 */
export function formatDelta(value: number, base: number | null, flatLabel: string): Delta | null {
  if (base === null || !Number.isFinite(base) || !Number.isFinite(value)) return null;
  const diff = Math.round(value - base);
  if (diff > 0) return { kind: "up", text: `+${formatCount(diff)}` };
  if (diff < 0) return { kind: "down", text: `−${formatCount(-diff)}` };
  return { kind: "flat", text: flatLabel };
}

/** `value` as a percentage of `top`, clamped to [0, 100]. */
export function pctOf(value: number, top: number): number {
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(top) || top <= 0) return 0;
  return Math.min((value / top) * 100, 100);
}

// ── The daily chart ────────────────────────────────────────────────────────

export interface YScale {
  /** The plot's ceiling; a bar of this height fills it. */
  top: number;
  /** Gridline values from 0 to `top`, evenly spaced. */
  ticks: number[];
}

/** Round steps for a head count: 1, 2, 2.5, 5 times a power of ten, whole numbers only. */
const STEP_MULTIPLIERS = [1, 2, 2.5, 5, 10];
/** Aim for about three intervals, i.e. four labelled lines including 0. */
const TARGET_INTERVALS = 3;

/**
 * About four round gridlines covering `max`: 54 → 0/20/40/60.
 *
 * An all-zero (or nonsense) series gets a single baseline and a ceiling of 1,
 * so every bar is honestly 0% tall instead of NaN.
 */
export function yScale(max: number): YScale {
  if (!Number.isFinite(max) || max <= 0) return { top: 1, ticks: [0] };
  const raw = max / TARGET_INTERVALS;
  let step = 1;
  if (raw > 1) {
    const base = 10 ** Math.floor(Math.log10(raw));
    step =
      STEP_MULTIPLIERS.map((k) => k * base).find((s) => Number.isInteger(s) && s >= raw) ?? 10 * base;
  }
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  return { top, ticks };
}

export type AxisLabel = { kind: "today" } | { kind: "date"; text: string } | null;

/** A weekly date label this close to the "today" label would print on top of it. */
const MIN_SLOTS_BEFORE_TODAY = 3;
const WEEK = 7;

/**
 * Which bars get a label under them: every 7th day from the first, plus
 * "today" under the day that is not over yet. A weekly label fewer than three
 * slots before today is dropped — on a phone the two would overlap.
 */
export function xAxisLabels(points: readonly Pick<AdminActivityDay, "date" | "partial">[]): AxisLabel[] {
  const todayAt = points.findIndex((p) => p.partial);
  return points.map((p, i) => {
    if (p.partial) return { kind: "today" };
    if (i % WEEK !== 0) return null;
    if (todayAt >= 0 && todayAt > i && todayAt - i < MIN_SLOTS_BEFORE_TODAY) return null;
    return { kind: "date", text: monthDaySlash(p.date) };
  });
}

/**
 * The bar the readout shows before anyone hovers: the last FULL day. Today's
 * half-day is the number most likely to be misread as a drop, so it is never
 * the default.
 */
export function readoutDefaultIndex(points: readonly Pick<AdminActivityDay, "partial">[]): number {
  for (let i = points.length - 1; i >= 0; i--) {
    if (!points[i].partial) return i;
  }
  return points.length - 1;
}

export interface DailySummary {
  /** How many full days were averaged. */
  days: number;
  avgReturning: number;
  avgSignupDay: number;
  /** The full day with the most returning people; the latest one on a tie. */
  peak: { returning: number; date: string };
  /** Some averaged day predates instrumentation, so the figures are floors. */
  reconstructed: boolean;
}

/** The line under the chart, over the days that are over (today excluded). */
export function dailySummary(points: readonly AdminActivityDay[]): DailySummary | null {
  const full = points.filter((p) => !p.partial);
  if (full.length === 0) return null;
  let returning = 0;
  let signupDay = 0;
  let peak = full[0];
  for (const p of full) {
    returning += p.returning;
    signupDay += p.signupDay;
    if (p.returning >= peak.returning) peak = p;
  }
  return {
    days: full.length,
    avgReturning: returning / full.length,
    avgSignupDay: signupDay / full.length,
    peak: { returning: peak.returning, date: peak.date },
    reconstructed: full.some((p) => !p.instrumented),
  };
}

// ── Depth ──────────────────────────────────────────────────────────────────

export type DepthLabel =
  | { kind: "onlyOne" }
  | { kind: "exact"; days: number }
  | { kind: "range"; min: number; max: number };

/** 1..1 → "only 1 day", N..N → "N days", otherwise "min–max days". */
export function depthLabel(bucket: Pick<AdminDepthBucket, "min" | "max">): DepthLabel {
  if (bucket.min === bucket.max) {
    return bucket.min === 1 ? { kind: "onlyOne" } : { kind: "exact", days: bucket.min };
  }
  return { kind: "range", min: bucket.min, max: bucket.max };
}

export interface DepthRow extends AdminDepthBucket {
  label: DepthLabel;
  /** Bar length, relative to the largest bucket. */
  barPct: number;
  /** Share of everyone active in the window, one decimal. */
  share: string;
}

export function depthRows(depth: AdminActivityDepth): DepthRow[] {
  const largest = Math.max(0, ...depth.buckets.map((b) => b.count));
  return depth.buckets.map((b) => ({
    ...b,
    label: depthLabel(b),
    barPct: pctOf(b.count, largest),
    share: formatPercent(depth.total > 0 ? b.count / depth.total : 0),
  }));
}

/** The 1-day bucket's head count (the footer's "of the X who came once"). */
export function oneDayCount(depth: AdminActivityDepth): number {
  return depth.buckets.find((b) => b.min === 1 && b.max === 1)?.count ?? 0;
}

// ── Cohorts ────────────────────────────────────────────────────────────────

export const COHORT_HORIZONS = [1, 7, 14, 30] as const;
export type CohortHorizonDays = (typeof COHORT_HORIZONS)[number];

/**
 * One cell of the retention table. Only an eligible cell carries a rate: a
 * horizon that is not over yet is still growing, and a rate printed for it
 * would be read as a result.
 */
export type CohortCell =
  | { state: "eligible"; days: CohortHorizonDays; returned: number; rate: number }
  | { state: "pending"; days: CohortHorizonDays; returned: number }
  | { state: "none"; days: CohortHorizonDays };

/**
 * The four cells of a signup week, in column order: eligible horizons show a
 * rate, the first horizon that is not over shows "N so far", any later one is
 * empty. A week nobody signed up in has nothing to show anywhere.
 */
export function cohortCells(week: AdminCohortWeek): CohortCell[] {
  let pendingShown = false;
  return COHORT_HORIZONS.map((days): CohortCell => {
    const h = week.horizons.find((x) => x.days === days);
    if (!h || week.signups <= 0) return { state: "none", days };
    if (h.eligible) return { state: "eligible", days, returned: h.returned, rate: h.returned / week.signups };
    if (pendingShown) return { state: "none", days };
    pendingShown = true;
    return { state: "pending", days, returned: h.returned };
  });
}

const SHADE_FLOOR = 0.06;
const SHADE_SPAN = 0.34;
/** The rate at which the shading reaches FLOOR + SPAN. */
const SHADE_FULL_RATE = 0.15;
const SHADE_CAP = 0.42;

/** Background alpha for an eligible cell: faint at 0%, strong from about 15%. */
export function cohortShade(rate: number): number {
  const r = Number.isFinite(rate) && rate > 0 ? rate : 0;
  return Math.min(SHADE_CAP, SHADE_FLOOR + (r / SHADE_FULL_RATE) * SHADE_SPAN);
}

// ── Depth row → user list ──────────────────────────────────────────────────
//
// The depth rows filter the user list below to one bucket. The two sections do
// not share state; they talk through one window event. The user-list side
// listens for it, applies the filter and resets to page 1. Nothing touches the
// URL: Next's router owns history.
//
// The event's name and detail type belong to the user list and are defined in
// src/lib/adminUsers.ts, so the sender and the listener cannot drift apart.

interface DepthEventEnv {
  target: Pick<EventTarget, "dispatchEvent">;
  doc: { getElementById(id: string): { scrollIntoView(opts?: ScrollIntoViewOptions): void } | null };
}

/** Ask the user list for one depth bucket, then bring the list into view. */
export function showUsersAtDepth(
  detail: AdminUsersDepthDetail,
  env: DepthEventEnv = { target: window, doc: document },
): void {
  env.target.dispatchEvent(new CustomEvent<AdminUsersDepthDetail>(ADMIN_USERS_DEPTH_EVENT, { detail }));
  env.doc.getElementById("users")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ── The wire ───────────────────────────────────────────────────────────────

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const nums = (o: Rec, keys: readonly string[]) => keys.every((k) => isNum(o[k]));
const numOrNull = (v: unknown) => v === null || isNum(v);

const isWindow = (v: unknown) =>
  isRec(v) &&
  nums(v, ["days", "active", "returning", "signupOnly", "prevActive", "prevReturning", "prevSignupOnly"]) &&
  isBool(v.reconstructed) &&
  isBool(v.prevReconstructed);

const isDay = (v: unknown) =>
  isRec(v) &&
  isStr(v.date) &&
  nums(v, ["returning", "signupDay", "requests", "logins"]) &&
  isBool(v.instrumented) &&
  isBool(v.partial);

const isBucket = (v: unknown) => isRec(v) && nums(v, ["min", "max", "count"]);

const isHorizon = (v: unknown) => isRec(v) && nums(v, ["days", "returned"]) && isBool(v.eligible);

const isWeek = (v: unknown) =>
  isRec(v) &&
  isStr(v.weekStart) &&
  isNum(v.signups) &&
  (v.lastSignup === null || isStr(v.lastSignup)) &&
  isBool(v.reconstructed) &&
  Array.isArray(v.horizons) &&
  v.horizons.every(isHorizon);

/**
 * Whether a response really is an AdminActivityPanel.
 *
 * The panel renders a failed fetch as an error box, never as zeroes — and a
 * payload of the wrong shape is a failed fetch too. The likeliest one is the
 * old dau/wau/mau response from a server that has not been redeployed yet;
 * without this check it would crash the page instead.
 */
export function isActivityPanel(value: unknown): value is AdminActivityPanel {
  if (!isRec(value)) return false;
  const { todayActive: ta, windows: w, signups30: s, depth: d } = value;
  return (
    isNum(value.days) &&
    isStr(value.timezone) &&
    isStr(value.today) &&
    isStr(value.asOf) &&
    (value.instrumentedSince === null || isStr(value.instrumentedSince)) &&
    isRec(ta) &&
    isNum(ta.active) &&
    numOrNull(ta.sameTimeYesterday) &&
    numOrNull(ta.sameTimeLastWeek) &&
    isNum(ta.yesterdayTotal) &&
    isRec(w) &&
    isWindow(w.d7) &&
    isWindow(w.d30) &&
    isRec(s) &&
    nums(s, ["count", "prevCount", "returnedAfter"]) &&
    isBool(s.reconstructed) &&
    Array.isArray(value.daily) &&
    value.daily.every(isDay) &&
    isRec(d) &&
    nums(d, ["days", "total", "signupOnly"]) &&
    isBool(d.reconstructed) &&
    Array.isArray(d.buckets) &&
    d.buckets.every(isBucket) &&
    Array.isArray(value.cohorts) &&
    value.cohorts.every(isWeek)
  );
}

// The arithmetic behind the admin user list and the user detail drawer, kept
// out of the components so it can be checked without a DOM.
//
// Two rules hold for everything here, because the list is server-rendered and
// then hydrated and both passes must print the same characters:
//
//   - An instant is shown on the site's reporting clock, Asia/Shanghai, by
//     fixed-offset arithmetic (+08 has no daylight saving): add eight hours,
//     read the UTC fields. Never the machine's zone, never toLocale*.
//   - "Today" is the payload's `today` (a YYYY-MM-DD reporting day), never
//     Date.now(). Calendar strings are split by hand and counted with
//     Date.UTC, never handed to `new Date(str)`, which reads a bare date as
//     UTC midnight and a date-time as local time.
//
// No React, no DOM, no dictionary imports: the activity panel imports the
// depth event from here, and so do bun tests.

import type {
  AdminUserDetail,
  AdminUserRow,
  AdminUserSegment,
  AdminUserSort,
  AdminUsersPage,
} from "@/app/[lang]/admin/_types/users";
import { fillTemplate } from "@/lib/home/time";

// ─── The activity panel → user list hand-off ─────────────────────────────

/**
 * Dispatched on `window` by the activity panel's depth rows ("近 30 天来过几天"):
 * the user list filters to that bucket. A DOM event rather than the URL, because
 * Next's router owns history and the two sections share nothing else.
 */
export const ADMIN_USERS_DEPTH_EVENT = "admin:users-depth";

/** The event's `detail`: people active on min..max distinct days of the last `days`. */
export interface AdminUsersDepthDetail {
  days: number;
  min: number;
  max: number;
}

/** The windows go-api accepts for the depth filter; anything else it ignores. */
export const DEPTH_WINDOWS = [7, 30, 90] as const;
export type DepthWindow = (typeof DEPTH_WINDOWS)[number];

/** A depth filter the list can send: a known window and 1 <= min <= max <= days. */
export interface AdminUsersDepth {
  days: DepthWindow;
  min: number;
  max: number;
}

const isDepthWindow = (v: unknown): v is DepthWindow => (DEPTH_WINDOWS as readonly unknown[]).includes(v);

/**
 * The event's detail, validated. A max past the window (or an open-ended one)
 * is clamped to it: nobody is active on more days than the window has, so the
 * filter is the same and the chip reads "14–30" rather than "14–∞".
 */
export function parseDepthDetail(detail: unknown): AdminUsersDepth | null {
  if (!detail || typeof detail !== "object") return null;
  const { days, min, max } = detail as Record<string, unknown>;
  if (!isDepthWindow(days) || typeof min !== "number" || typeof max !== "number") return null;
  if (!Number.isInteger(min) || min < 1) return null;
  const top = max === Infinity ? days : max;
  if (!Number.isInteger(top)) return null;
  const clamped = Math.min(top, days);
  return min <= clamped ? { days, min, max: clamped } : null;
}

/** "近 30 天来过 3–6 天", or "近 30 天来过 2 天" when the bucket is one value. */
export function depthChipLabel(depth: AdminUsersDepth, templates: { range: string; single: string }): string {
  return depth.min === depth.max
    ? fillTemplate(templates.single, { days: depth.days, n: depth.min })
    : fillTemplate(templates.range, { days: depth.days, min: depth.min, max: depth.max });
}

// ─── The list query ───────────────────────────────────────────────────────

/** In chip order. */
export const USER_SEGMENTS = [
  "all",
  "active7",
  "returned",
  "neverReturned",
  "subscribed",
  "admin",
] as const satisfies readonly AdminUserSegment[];

/** In the sort select's order. */
export const USER_SORTS = [
  "lastSeen",
  "joined",
  "activeDays",
  "subscriptions",
  "watched",
] as const satisfies readonly AdminUserSort[];

export const isUserSegment = (v: unknown): v is AdminUserSegment => (USER_SEGMENTS as readonly unknown[]).includes(v);
export const isUserSort = (v: unknown): v is AdminUserSort => (USER_SORTS as readonly unknown[]).includes(v);

export interface AdminUsersQuery {
  page: number;
  q: string;
  segment: AdminUserSegment;
  sort: AdminUserSort;
  depth: AdminUsersDepth | null;
}

/** What the server renders the page with: `/api/admin/users?page=1`. */
export const DEFAULT_USERS_QUERY: AdminUsersQuery = {
  page: 1,
  q: "",
  segment: "all",
  sort: "lastSeen",
  depth: null,
};

/**
 * The query string for GET /api/admin/users. Defaults are left out, so the
 * default query is byte-for-byte the one the server-side fetch made and the
 * section can tell it already holds that page.
 */
export function usersQueryString(query: AdminUsersQuery): string {
  const params = new URLSearchParams();
  params.set("page", String(Math.max(1, Math.floor(query.page) || 1)));
  const q = query.q.trim();
  if (q) params.set("q", q);
  if (query.segment !== "all") params.set("segment", query.segment);
  if (query.sort !== "lastSeen") params.set("sort", query.sort);
  if (query.depth) {
    params.set("depthDays", String(query.depth.days));
    params.set("depthMin", String(query.depth.min));
    params.set("depthMax", String(query.depth.max));
  }
  return params.toString();
}

// ─── +08 instants and calendar days ───────────────────────────────────────

/** The list's strip: today and the 29 days before it, as go-api's recentActiveDates. */
export const STRIP_DAYS = 30;
/** The drawer's calendar, as go-api's activity.days90. */
export const CALENDAR_DAYS = 90;

const SHANGHAI_OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad = (n: number): string => String(n).padStart(2, "0");

interface ShanghaiParts {
  /** YYYY-MM-DD on the reporting clock. */
  date: string;
  /** HH:mm on the reporting clock. */
  time: string;
  year: number;
}

/** An RFC 3339 instant on the +08 clock; null when it does not parse. */
function shanghaiParts(iso: string | null | undefined): ShanghaiParts | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms + SHANGHAI_OFFSET_MS);
  const year = d.getUTCFullYear();
  return {
    date: `${year}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
    year,
  };
}

/** "2026-03-18" for an instant, on the +08 clock; "" when it does not parse. */
export function shanghaiDate(iso: string | null | undefined): string {
  return shanghaiParts(iso)?.date ?? "";
}

/** "2026-03-18 07:30" for an instant, on the +08 clock; "" when it does not parse. */
export function shanghaiDateTime(iso: string | null | undefined): string {
  const p = shanghaiParts(iso);
  return p ? `${p.date} ${p.time}` : "";
}

/** UTC midnight of a YYYY-MM-DD calendar day, or null. */
function dayMs(day: string): number | null {
  const m = DAY_RE.exec(day);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(ms) ? ms : null;
}

const msToDay = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

export const isDay = (v: unknown): v is string => typeof v === "string" && dayMs(v) !== null;

/** The calendar day `n` days after `day` (negative for before). */
export function addDays(day: string, n: number): string {
  const ms = dayMs(day);
  return ms === null ? day : msToDay(ms + n * DAY_MS);
}

/** `to` minus `from`, in whole days; null when either does not parse. */
export function daysBetween(from: string, to: string): number | null {
  const a = dayMs(from);
  const b = dayMs(to);
  return a === null || b === null ? null : Math.round((b - a) / DAY_MS);
}

/** 1 = Monday … 7 = Sunday. */
function isoWeekday(day: string): number {
  const ms = dayMs(day);
  return ms === null ? 1 : ((new Date(ms).getUTCDay() + 6) % 7) + 1;
}

/** "04-02" in today's year, "2027-01-02" in any other. */
export function shortDate(day: string, today: string): string {
  return day.slice(0, 4) === today.slice(0, 4) ? day.slice(5) : day;
}

/** "03-15 17:08" in today's year, "2025-12-31 01:00" in any other; "" when unparseable. */
export function shortDateTime(iso: string | null | undefined, today: string): string {
  const p = shanghaiParts(iso);
  return p ? `${shortDate(p.date, today)} ${p.time}` : "";
}

/** "8-28": a reporting day as the legends write it. */
export function monthDay(day: string): string {
  const m = DAY_RE.exec(day);
  return m ? `${Number(m[2])}-${m[3]}` : day;
}

// ─── Relative labels ──────────────────────────────────────────────────────

export interface RelativeDay {
  /** "later" only when the instant is past the payload's today (clock skew at midnight). */
  kind: "today" | "yesterday" | "daysAgo" | "later";
  /** today − the instant's day; negative for "later". */
  days: number;
  date: string;
  time: string;
}

/** Where an instant falls relative to the payload's `today`, on the +08 calendar. */
export function relativeDay(iso: string | null | undefined, today: string): RelativeDay | null {
  const p = shanghaiParts(iso);
  if (!p) return null;
  const days = daysBetween(p.date, today);
  if (days === null) return null;
  const kind = days < 0 ? "later" : days === 0 ? "today" : days === 1 ? "yesterday" : "daysAgo";
  return { kind, days, date: p.date, time: p.time };
}

export type ReturnNote = { kind: "signupDay" } | { kind: "firstReturn"; days: number } | null;

/**
 * The line under 最近活跃 for someone seen today or yesterday: 注册当天 when that
 * last visit was on their signup day, 注册后第 N 天回来 when it was their first
 * return. Only judged when the signup is inside the 30-day strip — otherwise
 * the strip cannot say whether there were returns before it.
 */
export function returnNote(
  row: Pick<AdminUserRow, "createdAt" | "lastSeenAt" | "recentActiveDates">,
  today: string,
): ReturnNote {
  const signup = shanghaiDate(row.createdAt);
  const last = shanghaiDate(row.lastSeenAt);
  if (!signup || !last) return null;
  if (last === signup) return { kind: "signupDay" };
  const sinceSignup = daysBetween(signup, today);
  if (sinceSignup === null || sinceSignup < 0 || sinceSignup >= STRIP_DAYS) return null;
  const returns = (row.recentActiveDates ?? []).filter((d) => d > signup);
  if (returns.length !== 1 || returns[0] !== last) return null;
  const days = daysBetween(signup, last);
  return days !== null && days > 0 ? { kind: "firstReturn", days } : null;
}

// ─── The 30-day strip ─────────────────────────────────────────────────────

export interface StripCell {
  date: string;
  active: boolean;
  today: boolean;
}

/** `span` cells ending on `today` (the last one), active where `dates` has the day. */
export function activityStrip(
  dates: readonly string[] | null | undefined,
  today: string,
  span: number = STRIP_DAYS,
): StripCell[] {
  const active = new Set(dates ?? []);
  return Array.from({ length: span }, (_, i) => {
    const date = addDays(today, i - (span - 1));
    return { date, active: active.has(date), today: i === span - 1 };
  });
}

// ─── The 90-day visit calendar ────────────────────────────────────────────

/** recorded: per-request data; reconstructed: an interaction day from before it; outside: not in the window. */
export type CalendarState = "recorded" | "reconstructed" | "none" | "outside";

export interface CalendarCell {
  date: string;
  state: CalendarState;
  today: boolean;
  /** 1 = Monday … 7 = Sunday. */
  weekday: number;
}

export interface CalendarWeek {
  /** The column's Monday. */
  start: string;
  /** The month (1–12) labelled above this column, if any. */
  month: number | null;
  cells: CalendarCell[];
}

export interface CalendarModel {
  weeks: CalendarWeek[];
  /** Active days in the window. */
  active: number;
  /** Of those, reconstructed ones. */
  reconstructed: number;
  /** Active days in the last 30 of them. */
  last30: number;
}

/**
 * Monday-first week columns covering [today − span + 1, today]. Cells before
 * the window or after today are "outside" (drawn blank), so the grid stays a
 * rectangle without claiming a day had no visit. A month is labelled on the
 * column holding its 1st; the first column is labelled too when neither it
 * nor the next one holds a 1st, so the grid never starts unnamed.
 */
export function visitCalendar(
  days: readonly { date: string; recorded: boolean }[],
  today: string,
  span: number = CALENDAR_DAYS,
): CalendarModel {
  const first = addDays(today, -(span - 1));
  const recentStart = addDays(today, -(STRIP_DAYS - 1));
  const byDate = new Map<string, boolean>();
  for (const d of days) {
    if (d.date >= first && d.date <= today) byDate.set(d.date, d.recorded === true);
  }
  const gridStart = addDays(first, -(isoWeekday(first) - 1));
  const total = (daysBetween(gridStart, today) ?? 0) + 1;
  const weekCount = Math.ceil(total / 7);

  const columns: CalendarWeek[] = Array.from({ length: weekCount }, (_, w) => {
    const start = addDays(gridStart, w * 7);
    const cells = Array.from({ length: 7 }, (_, i): CalendarCell => {
      const date = addDays(start, i);
      const inside = date >= first && date <= today;
      const seen = byDate.get(date);
      const state: CalendarState = !inside
        ? "outside"
        : seen === undefined
          ? "none"
          : seen
            ? "recorded"
            : "reconstructed";
      return { date, state, today: date === today, weekday: i + 1 };
    });
    const firstOfMonth = cells.find((c) => c.date.endsWith("-01"));
    return { start, month: firstOfMonth ? Number(firstOfMonth.date.slice(5, 7)) : null, cells };
  });

  const unnamedStart = columns.length > 0 && columns[0].month === null && (columns[1]?.month ?? null) === null;
  const weeks = unnamedStart
    ? columns.map((week, i) => (i === 0 ? { ...week, month: Number(first.slice(5, 7)) } : week))
    : columns;

  let reconstructed = 0;
  let last30 = 0;
  for (const [date, recorded] of byDate) {
    if (!recorded) reconstructed += 1;
    if (date >= recentStart) last30 += 1;
  }
  return { weeks, active: byDate.size, reconstructed, last30 };
}

// ─── Payload guards ───────────────────────────────────────────────────────

const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * GET /api/admin/users, or null when the body is not that. A row missing its
 * strip or device reads as "none" rather than crashing the table; a body with
 * no `today` is refused outright, because every relative label hangs off it.
 */
export function readUsersPage(body: unknown): AdminUsersPage | null {
  const b = record(body);
  if (!b || !Array.isArray(b.data) || !isDay(b.today)) return null;
  const data = b.data
    .map(record)
    .filter((r): r is Record<string, unknown> => r !== null && typeof r._id === "string" && typeof r.username === "string")
    .map((r) => ({
      ...(r as unknown as AdminUserRow),
      recentActiveDates: Array.isArray(r.recentActiveDates) ? r.recentActiveDates.filter(isDay) : [],
      lastDevice: record(r.lastDevice) ? (r.lastDevice as AdminUserRow["lastDevice"]) : null,
    }));
  return {
    data,
    hasMore: b.hasMore === true,
    total: typeof b.total === "number" ? b.total : data.length,
    page: typeof b.page === "number" ? b.page : 1,
    today: b.today,
    segments: (record(b.segments) ?? {}) as AdminUsersPage["segments"],
  };
}

/** GET /api/admin/users/{id}'s `data`, or null when any block the drawer draws is missing. */
export function readUserDetail(body: unknown): AdminUserDetail | null {
  const b = record(body);
  const user = record(b?.user);
  const activity = record(b?.activity);
  if (!b || !isDay(b.today) || !user || typeof user._id !== "string" || typeof user.username !== "string") return null;
  if (!activity || !Array.isArray(activity.days90)) return null;
  if (!record(b.subscriptions) || !record(b.watches) || !record(b.community)) return null;
  if (!Array.isArray(b.recentWatches) || !Array.isArray(b.recentSubscriptions) || !Array.isArray(b.sessions)) return null;
  return b as unknown as AdminUserDetail;
}

// ─── The drawer and the row menu ──────────────────────────────────────────

/** What the drawer opens on: the details, or one of the row menu's actions already open. */
export type UserDrawerMode = "view" | "edit" | "password" | "revokeAll" | "delete";

/** The account a drawer is for, as the row knew it — enough to draw the header before the fetch. */
export interface UserDrawerTarget {
  id: string;
  username: string;
  email: string;
  role: string | null;
  createdAt: string;
  mode: UserDrawerMode;
}

export interface MenuPlacement {
  /** Set when the menu opens below its button. */
  top: number | null;
  /** Set when it opens above, because there is no room below. */
  bottom: number | null;
  /** Right edge aligned with the button's, from the viewport's right. */
  right: number;
}

/**
 * Where the ⋯ menu goes, in viewport coordinates (it is position: fixed, out
 * of the table's scroller). Below the button, unless that would run off the
 * bottom and there is more room above.
 */
export function menuPlacement(
  anchor: { top: number; bottom: number; right: number },
  viewport: { width: number; height: number },
  menuHeight: number,
  gap = 4,
): MenuPlacement {
  const right = Math.max(8, viewport.width - anchor.right);
  const below = viewport.height - anchor.bottom - gap;
  if (below >= menuHeight || below >= anchor.top - gap) {
    return { top: anchor.bottom + gap, bottom: null, right };
  }
  return { top: null, bottom: viewport.height - anchor.top + gap, right };
}

// ─── Display bits ─────────────────────────────────────────────────────────

// A fixed locale: the server's default and the browser's can differ, and a
// count that groups differently after hydration is a mismatch.
const COUNT = new Intl.NumberFormat("en-US");

export function formatCount(n: number): string {
  return Number.isFinite(n) ? COUNT.format(n) : "—";
}

/** One decimal: "8.5". */
export function formatScore(n: number): string {
  return (Math.round(n * 10) / 10).toFixed(1);
}

const AVATAR_COLORS = ["#8cc2f0", "#f0a6c9", "#a7e3c4", "#f5c98a", "#c7b8f5", "#9fd8e8"];

export function avatarInitial(name: string): string {
  return (Array.from(name.trim())[0] ?? "?").toUpperCase();
}

/** A stable pastel per name, so the same person keeps their colour across pages. */
export function avatarColor(name: string): string {
  const code = name.length > 0 ? name.charCodeAt(0) : 0;
  return AVATAR_COLORS[(code + name.length) % AVATAR_COLORS.length];
}

/** "Windows · Edge"; the unknown half named; "未知设备" when neither is known. */
export function deviceLabel(
  os: string,
  browser: string,
  words: { unknownOs: string; unknownBrowser: string; unknownDevice: string },
): string {
  const system = os.trim();
  const app = browser.trim();
  if (!system && !app) return words.unknownDevice;
  return `${system || words.unknownOs} · ${app || words.unknownBrowser}`;
}

/** An ISO 3166 alpha-2 code worth showing, or null. */
export function countryCode(v: string | null | undefined): string | null {
  const code = v?.trim().toUpperCase() ?? "";
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

// ─── The drawer's edit and password forms ─────────────────────────────────

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 50;
export const PASSWORD_MIN = 6;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ProfilePatch =
  | { kind: "invalid"; reason: "usernameLength" | "emailFormat" }
  | { kind: "unchanged" }
  | { kind: "patch"; patch: { username?: string; email?: string } };

/**
 * The minimum PATCH body for an edit: only the fields that changed, trimmed.
 * The same first-line checks the row used to make; the server action and
 * go-api check again.
 */
export function profilePatch(
  form: { username: string; email: string },
  current: { username: string; email: string },
): ProfilePatch {
  const username = form.username.trim();
  const email = form.email.trim();
  if (username.length < USERNAME_MIN || username.length > USERNAME_MAX) {
    return { kind: "invalid", reason: "usernameLength" };
  }
  if (!EMAIL_RE.test(email)) return { kind: "invalid", reason: "emailFormat" };
  const patch: { username?: string; email?: string } = {};
  if (username !== current.username) patch.username = username;
  if (email !== current.email) patch.email = email;
  return Object.keys(patch).length === 0 ? { kind: "unchanged" } : { kind: "patch", patch };
}

export function passwordProblem(password: string): "short" | null {
  return password.length < PASSWORD_MIN ? "short" : null;
}

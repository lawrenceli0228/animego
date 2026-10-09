// Dates and the few sentences the community tab builds out of data.
//
// Dates are absolute ("10 月 4 日") and computed in the site's own zone, not
// the reader's: the page is server-rendered once into a cache and hydrated in
// every reader's browser, and a date that depends on where the reader is
// would differ between the two and fail hydration. The clock that decides
// whether to print the year is passed in for the same reason — the caller
// pins one at render time and both sides use it.

import type { Lang } from "@/lib/i18n/lang";
import { SITE_TZ } from "@/lib/home/time";
import type { SubscriptionStatus, WatcherCounts } from "./types";

interface DateParts {
  year: number;
  month: number;
  day: number;
}

const PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: SITE_TZ,
  year: "numeric",
  month: "numeric",
  day: "numeric",
});

function partsOf(ms: number): DateParts {
  const out: DateParts = { year: 0, month: 0, day: 0 };
  for (const part of PARTS.formatToParts(new Date(ms))) {
    if (part.type === "year") out.year = Number(part.value);
    if (part.type === "month") out.month = Number(part.value);
    if (part.type === "day") out.day = Number(part.value);
  }
  return out;
}

const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "10 月 4 日", or "2025 年 10 月 4 日" when it is not this year (by `nowMs`).
 * English: "Oct 4" / "Oct 4, 2025". Empty for an unparseable value.
 */
export function formatCommunityDate(iso: string, lang: Lang, nowMs: number): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const d = partsOf(ms);
  const sameYear = d.year === partsOf(nowMs).year;
  if (lang === "en") {
    const md = `${EN_MONTHS[d.month - 1]} ${d.day}`;
    return sameYear ? md : `${md}, ${d.year}`;
  }
  const md = `${d.month} 月 ${d.day} 日`;
  return sameYear ? md : `${d.year} 年 ${md}`;
}

/** The i18n key for a status's short label (the chip: 看完 / 在看 …). */
export const STATUS_LABEL_KEY: Record<SubscriptionStatus, string> = {
  watching: "community.statusWatching",
  completed: "community.statusCompleted",
  plan_to_watch: "community.statusPlanToWatch",
  dropped: "community.statusDropped",
};

/** The i18n key for an activity sentence ("{user} 看完了《{title}》"). */
export const ACTIVITY_KEY: Record<SubscriptionStatus, string> = {
  watching: "community.activityWatching",
  completed: "community.activityCompleted",
  plan_to_watch: "community.activityPlanToWatch",
  dropped: "community.activityDropped",
};

/** The i18n key for when a follower set their status ("{date}看完"). */
export const SINCE_KEY: Record<SubscriptionStatus, string> = {
  watching: "community.sinceWatching",
  completed: "community.sinceCompleted",
  plan_to_watch: "community.sincePlanToWatch",
  dropped: "community.sinceDropped",
};

/** The i18n key for "everyone is in this one state" ("都已看完"). */
export const ALL_KEY: Record<SubscriptionStatus, string> = {
  watching: "community.allWatching",
  completed: "community.allCompleted",
  plan_to_watch: "community.allPlanToWatch",
  dropped: "community.allDropped",
};

export interface StatusCount {
  status: SubscriptionStatus;
  count: number;
}

/** The non-zero statuses, most common first (ties in list order). */
export function statusBreakdown(counts: WatcherCounts): StatusCount[] {
  const rows: StatusCount[] = [
    { status: "watching", count: counts.watching },
    { status: "completed", count: counts.completed },
    { status: "plan_to_watch", count: counts.planToWatch },
    { status: "dropped", count: counts.dropped },
  ];
  return rows.filter((r) => r.count > 0).sort((a, b) => b.count - a.count);
}

/**
 * Fill `{{name}}` placeholders — the dictionaries' syntax, same as `fill` in
 * lib/i18n.ts, which this does not import because that module carries both
 * server dictionaries into any client chunk that touches it. Unknown names
 * are left as written.
 */
export function fillTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : whole,
  );
}

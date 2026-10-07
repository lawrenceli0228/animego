// "今日更新" — which of today's episodes have aired, which are about to, and
// where the "now" marker goes between them.
//
// Everything time-relative is a function of `nowMs`, which the rail supplies
// from a clock store: the server's render time during SSR and hydration, the
// browser's own clock (by the minute) afterwards. So the same input always
// produces the same output, and hydration cannot mismatch.
//
// Pure: no DOM, no React.

import { clockParts, nextDayKey } from "./time";

/** "N 分钟后" and the ping dot apply within this window. */
export const SOON_WINDOW_MS = 60 * 60_000;

export type SlotState = "aired" | "soon" | "later";

export interface Slot<T> {
  item: T;
  state: SlotState;
  /** Whole minutes until airing, rounded up. Only for `soon`. */
  minutesUntil: number | null;
}

export interface TodaySlots<T> {
  slots: Slot<T>[];
  /** Index in `slots` before which the "now" marker is drawn. */
  nowIndex: number;
}

export function slotToday<T extends { at: number }>(items: readonly T[], nowMs: number): TodaySlots<T> {
  // A stable copy: Array.prototype.sort is stable, and the input stays untouched.
  const sorted = [...items].sort((a, b) => a.at - b.at);
  const slots = sorted.map((item): Slot<T> => {
    const delta = item.at - nowMs;
    if (delta <= 0) return { item, state: "aired", minutesUntil: null };
    if (delta <= SOON_WINDOW_MS) {
      return { item, state: "soon", minutesUntil: Math.ceil(delta / 60_000) };
    }
    return { item, state: "later", minutesUntil: null };
  });
  const nowIndex = slots.filter((s) => s.state === "aired").length;
  return { slots, nowIndex };
}

/**
 * True when an airing falls on a later calendar day than `dayKey`, read in
 * `timeZone`.
 *
 * /api/anime/schedule groups by the server's day, which is UTC in production —
 * 08:00 to 08:00 in Shanghai. The late-night slots (JST 25:00 and after) are
 * therefore in "today's" group but after midnight on the clock, and get the
 * "次日" prefix. That matches how the broadcast day itself is counted.
 */
export function isNextDay(atMs: number, dayKey: string, timeZone: string | undefined): boolean {
  return clockParts(atMs, timeZone).dayKey > dayKey;
}

interface ScheduleLike<T extends { airingAt: number }> {
  today: string;
  groups: Record<string, T[] | undefined>;
}

/** The API's "today" group, in airing order. */
export function todayScheduleItems<T extends { airingAt: number }>(schedule: ScheduleLike<T>): T[] {
  const group = schedule.today ? schedule.groups[schedule.today] : undefined;
  return [...(group ?? [])].sort((a, b) => a.airingAt - b.airingAt);
}

/**
 * The day after the API's "today", and how many episodes it has — what the
 * end of 今日更新's row says comes next. Null when there is no today.
 */
export function tomorrowOf<T extends { airingAt: number }>(
  schedule: ScheduleLike<T>,
): { dayKey: string; count: number } | null {
  const dayKey = schedule.today ? nextDayKey(schedule.today) : null;
  if (!dayKey) return null;
  return { dayKey, count: schedule.groups[dayKey]?.length ?? 0 };
}

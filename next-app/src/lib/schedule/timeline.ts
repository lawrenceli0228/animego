// One day of the schedule page, in the shape the board draws: a row per
// airing time with every show at that time inside it, and the index the
// "现在 HH:MM" rule goes before.
//
// The per-show states come from the homepage's slotToday (aired / soon /
// later around `nowMs`), so the two pages can never disagree about whether an
// episode has gone out. Grouping is by the minute in epoch time, which is the
// same minute in every time zone, so the groups do not change when the
// browser takes over the clock from the server — only their labels do.
//
// Pure: no React, no DOM.

import { slotToday, type Slot } from "@/lib/home/todaySlots";

const MINUTE_MS = 60_000;

export interface TimeGroup<T> {
  /** The minute these shows air at, epoch ms. */
  at: number;
  slots: Slot<T>[];
  /** Every episode in the group has gone out. */
  aired: boolean;
}

export interface DayTimeline<T> {
  groups: TimeGroup<T>[];
  /**
   * The group the "now" rule is drawn before: the first one that has not
   * fully aired, or `groups.length` when all of them have.
   */
  nowIndex: number;
}

export function dayTimeline<T extends { at: number }>(items: readonly T[], nowMs: number): DayTimeline<T> {
  const groups: TimeGroup<T>[] = [];
  for (const slot of slotToday(items, nowMs).slots) {
    const minute = Math.floor(slot.item.at / MINUTE_MS) * MINUTE_MS;
    const last = groups[groups.length - 1];
    if (last && last.at === minute) {
      groups[groups.length - 1] = {
        ...last,
        slots: [...last.slots, slot],
        aired: last.aired && slot.state === "aired",
      };
    } else {
      groups.push({ at: minute, slots: [slot], aired: slot.state === "aired" });
    }
  }
  const firstOpen = groups.findIndex((g) => !g.aired);
  return { groups, nowIndex: firstOpen === -1 ? groups.length : firstOpen };
}

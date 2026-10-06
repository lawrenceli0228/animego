// The signed-in half of the schedule page: what the reader follows, where it
// airs this week, and one word for where they stand with it.
//
// `progress` is anilistId → the episode the reader has watched up to, from the
// watching list the page already fetched on the server. Everything that
// depends on whether an episode has gone out takes `nowMs`, so the box agrees
// with the rows' aired / upcoming states minute for minute.
//
// Pure: no React, no DOM.

import type { Lang } from "@/lib/i18n/lang";
import { clockParts, weekdayLabel } from "@/lib/home/time";

export type FollowState = "unwatched" | "watched" | "behind" | "upcoming";

export interface FollowEntry<T> {
  item: T;
  state: FollowState;
  /** Episodes already out that the reader has not watched. Only for "behind". */
  behind: number;
}

type Progress = Readonly<Record<number, number>>;

interface Airing {
  id: number;
  at: number;
  ep: number;
}

function stateOf(ep: number, watched: number, aired: boolean): { state: FollowState; behind: number } {
  if (aired) return { state: ep > watched ? "unwatched" : "watched", behind: 0 };
  // Episode `ep` is still to come; everything before it is out.
  const behind = ep - 1 - watched;
  return behind > 0 ? { state: "behind", behind } : { state: "upcoming", behind: 0 };
}

/**
 * Each followed show that airs in the window, once — at its first airing —
 * sorted by when that is.
 */
export function followingThisWeek<T extends Airing>(
  days: ReadonlyArray<{ items: readonly T[] }>,
  progress: Progress,
  nowMs: number,
): FollowEntry<T>[] {
  const first = new Map<number, T>();
  for (const day of days) {
    for (const it of day.items) {
      if (progress[it.id] === undefined) continue;
      const seen = first.get(it.id);
      if (!seen || it.at < seen.at) first.set(it.id, it);
    }
  }
  return [...first.values()]
    .sort((a, b) => a.at - b.at)
    .map((item) => ({ item, ...stateOf(item.ep, progress[item.id], item.at <= nowMs) }));
}

/**
 * The pill on a followed show's schedule row: "未看" once an episode past
 * the reader's progress has aired, "在追" otherwise. Null when not followed.
 */
export function rowFollowState(
  ep: number,
  watched: number | undefined,
  aired: boolean,
): "unwatched" | "following" | null {
  if (watched === undefined) return null;
  return aired && ep > watched ? "unwatched" : "following";
}

/**
 * "今天 21:00" / "周四 22:56" — when an airing is, read in `timeZone`.
 *
 * The weekday is the airing's own calendar day in that zone, not the API
 * group it sits in: a 06:40 episode in Wednesday's group airs on Thursday
 * morning, and that is what the reader needs to be told.
 */
export function whenLabel(atMs: number, nowMs: number, timeZone: string | undefined, lang: Lang, todayWord: string): string {
  const at = clockParts(atMs, timeZone);
  const day = at.dayKey === clockParts(nowMs, timeZone).dayKey ? todayWord : weekdayLabel(at.weekday, lang);
  return `${day} ${at.hh}:${at.mm}`;
}

// The year-grouped lists on the person page — 配音作品 and 制作作品 — as the
// page's two controls see them: a filter (新到旧 / 只看主角) and a collapsed
// first view with 「查看全部 N 部」 under it.
//
// The API already groups and orders (go-api/internal/people: newest first,
// undated titles on top). Everything here keeps that order and only removes:
// a filter takes roles out and drops the years it empties; collapsing keeps
// the first so many cards and the headings above them.

import type { VoiceYear } from "./types";

/**
 * How many cards a list shows before 「查看全部」: three rows of the desktop
 * grid's seven (seven rows of three on a phone). Enough for most people's
 * whole list — the button is for the long careers, where the newest few
 * years are what a visitor scans first.
 */
export const CARDS_SHOWN_COLLAPSED = 21;

export type VoiceFilter = "all" | "main";

export function isMainRole(role: string | null | undefined): boolean {
  return role?.toUpperCase() === "MAIN";
}

/** The voice timeline with only the lead roles, or all of it. Empty years are dropped. */
export function filterVoiceYears(years: readonly VoiceYear[], filter: VoiceFilter): VoiceYear[] {
  if (filter === "all") return [...years];
  return years
    .map((y) => ({ ...y, roles: y.roles.filter((r) => isMainRole(r.role)) }))
    .filter((y) => y.roles.length > 0);
}

/**
 * Whether 只看主角 changes anything: there must be a lead role to show and
 * something else to hide. With none, or nothing but leads, the control would
 * do nothing visible and is not offered.
 */
export function offersMainFilter(years: readonly VoiceYear[]): boolean {
  let main = 0;
  let total = 0;
  for (const y of years) {
    for (const r of y.roles) {
      total++;
      if (isMainRole(r.role)) main++;
    }
  }
  return main > 0 && main < total;
}

/** Distinct titles in a voice timeline: the N of 「查看全部 N 部」. */
export function voiceWorkCount(years: readonly VoiceYear[]): number {
  const ids = new Set<number>();
  for (const y of years) for (const r of y.roles) ids.add(r.anime.anilistId);
  return ids.size;
}

/**
 * The first `limit` items across year groups, keeping each group's heading
 * with the items under it. Groups past the limit are left out whole; the
 * group the limit falls in keeps its first items.
 */
export function takeItems<G, I>(
  groups: readonly G[],
  itemsOf: (group: G) => readonly I[],
  withItems: (group: G, items: I[]) => G,
  limit: number,
): G[] {
  const out: G[] = [];
  let left = limit;
  for (const g of groups) {
    if (left <= 0) break;
    const items = itemsOf(g);
    const kept = items.slice(0, left);
    out.push(kept.length === items.length ? g : withItems(g, kept));
    left -= kept.length;
  }
  return out;
}

/** Total items across groups. */
export function countItems<G>(groups: readonly G[], itemsOf: (group: G) => readonly unknown[]): number {
  return groups.reduce((n, g) => n + itemsOf(g).length, 0);
}

// Filtering and sorting the season, and the state changes the controls make.
//
// Everything a click does to the page is a function here from one state to
// the next, so the rules ("picking a weekday sorts by air time; clearing it
// sorts back") are tested once and shared by the desktop bar, the phone sheet
// and the tag row.
//
// Pure: no React, no DOM.

import { HUE_FAMILIES, hueFamilyOf, type HueFamilyKey } from "@/lib/home/hueFamilies";
import { airWeekday, hasWeeklySlot, monthKeyOf, type BarMode } from "./bars";
import { minuteOfWeek } from "./clock";
import type { SeasonalItem } from "./model";
import {
  DEFAULT_STATE,
  SORT_KEYS,
  type BrowseState,
  type SortKey,
  type SourceGroup,
} from "./state";

// ── Source groups ───────────────────────────────────────────────────────────

/**
 * Which filter group an AniList source belongs to. Comics count as manga (漫改
 * is "adapted from a comic"); visual novels as games (游戏改). Every other
 * recorded source is OTHER, and a show with no source is in no group.
 */
const SOURCE_GROUP_OF: Readonly<Record<string, SourceGroup>> = {
  MANGA: "MANGA",
  COMIC: "MANGA",
  LIGHT_NOVEL: "LIGHT_NOVEL",
  ORIGINAL: "ORIGINAL",
  VIDEO_GAME: "GAME",
  GAME: "GAME",
  VISUAL_NOVEL: "GAME",
  NOVEL: "NOVEL",
  WEB_NOVEL: "WEB_NOVEL",
};

export function sourceGroupOf(source: string | null): SourceGroup | null {
  if (!source) return null;
  return SOURCE_GROUP_OF[source] ?? "OTHER";
}

// ── What the season's data can answer ──────────────────────────────────────

export interface Facets {
  /** The sorts this season's data can answer, in menu order. */
  sorts: SortKey[];
  /** Some show records its source. */
  source: boolean;
  /** Some show is known to be a sequel. */
  sequel: boolean;
}

/**
 * Controls the data cannot back are left out rather than shown doing nothing:
 * a go-api without the browse fields sends no favourites, no schedule and no
 * dates, and a 收藏 sort over all-null counts is the API order with a
 * different label.
 */
export function facetsOf(items: readonly SeasonalItem[]): Facets {
  const any = (pred: (item: SeasonalItem) => boolean) => items.some(pred);
  const fav = any((i) => i.favourites !== null);
  const next = any((i) => i.next !== null);
  const start = any((i) => i.start !== null);
  const sorts = SORT_KEYS.filter((key) => {
    if (key === "fav") return fav;
    if (key === "next" || key === "time") return next;
    if (key === "start") return start;
    return true;
  });
  // The sequel flag is false both for "a new series" and for "not known yet"
  // (relations are written only when a show's detail page is fetched), so
  // the filter is offered only once some show is known to be a sequel. It
  // stays best-effort after that: 只看新作 includes the unknowns.
  return { sorts, source: any((i) => i.source !== null), sequel: any((i) => i.sequel === true) };
}

/**
 * The state as this season can show it. A weekday filter means nothing in
 * month mode and a month filter nothing in weekday mode; a sort or filter the
 * data cannot back falls back to the default. Applied to whatever the URL
 * said, so a link from another season (or another era of the API) still lands
 * on a working page.
 */
export function settleState(state: BrowseState, facets: Facets, mode: BarMode): BrowseState {
  const wd = mode === "weekday" ? state.wd : 0;
  const mon = mode === "month" ? state.mon : "";
  const source = facets.source ? state.source : "";
  const seq = facets.sequel ? state.seq : "";
  const sort = facets.sorts.includes(state.sort) ? state.sort : DEFAULT_STATE.sort;
  if (
    wd === state.wd &&
    mon === state.mon &&
    source === state.source &&
    seq === state.seq &&
    sort === state.sort
  ) {
    return state;
  }
  return { ...state, wd, mon, source, seq, sort };
}

export interface HueOption {
  key: HueFamilyKey;
  /** The family's representative angle, for its dot. */
  hue: number;
  count: number;
}

/**
 * The hue families the season has covers in, in circle order, with how many
 * each holds. A family with nothing in it gets no dot: a filter that empties
 * the page is not a choice.
 */
export function hueOptionsOf(items: readonly SeasonalItem[]): HueOption[] {
  const counts = new Map<HueFamilyKey, number>();
  for (const item of items) {
    const key = hueFamilyOf(item.hue);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return HUE_FAMILIES.filter((f) => counts.has(f.key)).map((f) => ({
    key: f.key,
    hue: f.hue,
    count: counts.get(f.key) ?? 0,
  }));
}

// ── Filtering ───────────────────────────────────────────────────────────────

export function matchesState(item: SeasonalItem, state: BrowseState, mode: BarMode): boolean {
  const q = state.q.trim().toLowerCase();
  if (q && !item.haystack.includes(q)) return false;
  for (const g of state.genres) if (!item.genres.includes(g)) return false;
  if (state.format && item.format !== state.format) return false;
  if (state.status && item.status !== state.status) return false;
  if (state.source && sourceGroupOf(item.source) !== state.source) return false;
  if (state.seq === "new" && item.sequel !== false) return false;
  if (state.seq === "sequel" && item.sequel !== true) return false;
  if (state.wd && mode === "weekday" && airWeekday(item) !== state.wd) return false;
  if (state.mon && mode === "month" && monthKeyOf(item) !== state.mon) return false;
  if (state.hue && hueFamilyOf(item.hue) !== state.hue) return false;
  return true;
}

// ── Sorting ─────────────────────────────────────────────────────────────────

/** Larger first, unknown last. */
function desc(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

/** Smaller first, unknown last. */
function asc(a: number | string | null, b: number | string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

const byPopularity = (a: SeasonalItem, b: SeasonalItem) => desc(a.popularity, b.popularity);

/** Where a show's weekly slot falls in the week (the same slots the weekday chart counts). */
const slotMinute = (item: SeasonalItem) => (hasWeeklySlot(item) && item.next ? minuteOfWeek(item.next.at) : null);

const COMPARE: Record<SortKey, (a: SeasonalItem, b: SeasonalItem) => number> = {
  pop: byPopularity,
  score: (a, b) => desc(a.score, b.score) || byPopularity(a, b),
  fav: (a, b) => desc(a.favourites, b.favourites) || byPopularity(a, b),
  next: (a, b) => asc(a.next?.at ?? null, b.next?.at ?? null) || byPopularity(a, b),
  time: (a, b) => asc(slotMinute(a), slotMinute(b)) || byPopularity(a, b),
  start: (a, b) => asc(a.start, b.start) || byPopularity(a, b),
  title: (a, b) => a.titleRank - b.titleRank,
};

/** A new array; ties fall back to the API's own order, so every sort is total. */
export function sortItems(items: readonly SeasonalItem[], sort: SortKey): SeasonalItem[] {
  const compare = COMPARE[sort] ?? COMPARE.pop;
  return [...items].sort((a, b) => compare(a, b) || a.rank - b.rank);
}

/** The list the page shows for `state`. */
export function browseItems(items: readonly SeasonalItem[], state: BrowseState, mode: BarMode): SeasonalItem[] {
  return sortItems(
    items.filter((item) => matchesState(item, state, mode)),
    state.sort,
  );
}

// ── State changes ──────────────────────────────────────────────────────────

/** A sort that only makes sense under a filter goes back to the default with it. */
function sortWithout(sort: SortKey, dropped: SortKey): SortKey {
  return sort === dropped ? DEFAULT_STATE.sort : sort;
}

export function toggleGenre(state: BrowseState, genre: string): BrowseState {
  const genres = state.genres.includes(genre)
    ? state.genres.filter((g) => g !== genre)
    : [...state.genres, genre];
  return { ...state, genres };
}

/** A weekday bar: filter to it and sort by air time; press it again to undo both. */
export function toggleWeekday(state: BrowseState, weekday: number): BrowseState {
  if (state.wd === weekday) return { ...state, wd: 0, sort: sortWithout(state.sort, "time") };
  return { ...state, wd: weekday, mon: "", sort: "time" };
}

/** A month bar: filter to it and sort by start date; press it again to undo both. */
export function toggleMonth(state: BrowseState, month: string): BrowseState {
  if (state.mon === month) return { ...state, mon: "", sort: sortWithout(state.sort, "start") };
  return { ...state, mon: month, wd: 0, sort: "start" };
}

export function toggleHue(state: BrowseState, hue: HueFamilyKey): BrowseState {
  return { ...state, hue: state.hue === hue ? "" : hue };
}

/** Every filter off. The view stays; a sort that belonged to a filter goes with it. */
export function clearFilters(state: BrowseState): BrowseState {
  const sort = state.sort === "time" || state.sort === "start" ? DEFAULT_STATE.sort : state.sort;
  return { ...DEFAULT_STATE, view: state.view, sort };
}

/** The phone sheet's 重置: every filter off and the default sort. */
export function resetSheet(state: BrowseState): BrowseState {
  return { ...DEFAULT_STATE, view: state.view };
}

/**
 * The state a link to another season carries. Weekday and month are about
 * this season's calendar and do not travel; nor do the sorts they imply.
 */
export function stateForOtherSeason(state: BrowseState): BrowseState {
  return { ...state, wd: 0, mon: "", sort: state.sort === "time" || state.sort === "start" ? "pop" : state.sort };
}

// ── The tag row ─────────────────────────────────────────────────────────────

export type ActiveTag =
  | { kind: "q"; value: string }
  | { kind: "genre"; value: string }
  | { kind: "format"; value: string }
  | { kind: "status"; value: string }
  | { kind: "source"; value: SourceGroup }
  | { kind: "seq"; value: "new" | "sequel" }
  | { kind: "wd"; value: number }
  | { kind: "mon"; value: string }
  | { kind: "hue"; value: HueFamilyKey };

/** One removable tag per active filter, in the order the bar lays them out. */
export function activeTags(state: BrowseState): ActiveTag[] {
  const tags: ActiveTag[] = [];
  const q = state.q.trim();
  if (q) tags.push({ kind: "q", value: q });
  for (const g of state.genres) tags.push({ kind: "genre", value: g });
  if (state.format) tags.push({ kind: "format", value: state.format });
  if (state.status) tags.push({ kind: "status", value: state.status });
  if (state.source) tags.push({ kind: "source", value: state.source });
  if (state.seq) tags.push({ kind: "seq", value: state.seq });
  if (state.wd) tags.push({ kind: "wd", value: state.wd });
  if (state.mon) tags.push({ kind: "mon", value: state.mon });
  if (state.hue) tags.push({ kind: "hue", value: state.hue });
  return tags;
}

export function withoutTag(state: BrowseState, tag: ActiveTag): BrowseState {
  switch (tag.kind) {
    case "q":
      return { ...state, q: "" };
    case "genre":
      return { ...state, genres: state.genres.filter((g) => g !== tag.value) };
    case "format":
      return { ...state, format: "" };
    case "status":
      return { ...state, status: "" };
    case "source":
      return { ...state, source: "" };
    case "seq":
      return { ...state, seq: "" };
    case "wd":
      return { ...state, wd: 0, sort: sortWithout(state.sort, "time") };
    case "mon":
      return { ...state, mon: "", sort: sortWithout(state.sort, "start") };
    case "hue":
      return { ...state, hue: "" };
  }
}

/** The number on the phone's filter button: what the sheet itself controls. */
export function sheetFilterCount(state: BrowseState): number {
  return state.genres.length + (state.format ? 1 : 0) + (state.status ? 1 : 0);
}

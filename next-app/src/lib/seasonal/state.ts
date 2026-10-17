// What the seasonal page is showing, and how that is written in its URL.
//
// One parser for both sides: the server reads the request's query to render
// the first paint, the client reads `location.search` when a cached page is
// restored, and both must arrive at the same state for the same URL. Unknown
// or malformed values are dropped, never guessed at.
//
//   q       free text
//   genre   comma list of AniList genres ("Action,Comedy"; one value is the old form)
//   format  TV | TV_SHORT | MOVIE | SPECIAL | OVA | ONA
//   status  RELEASING | FINISHED | NOT_YET_RELEASED
//   source  a source group (SOURCE_GROUPS)
//   seq     new | sequel
//   wd      1–7, Monday to Sunday (Beijing)
//   mon     YYYY-MM | tbd
//   hue     a hue family key
//   sort    pop | score | fav | next | time | start | title
//   view    grid | chart | table
//
// `show` was the old "load more" cursor. It is read past and never written.
//
// Pure: no React, no DOM.

import { FILTER_GENRES } from "@/lib/contentLabels";
import { HUE_FAMILIES, type HueFamilyKey } from "@/lib/home/hueFamilies";

export const SORT_KEYS = ["pop", "score", "fav", "next", "time", "start", "title"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export const VIEW_KEYS = ["grid", "chart", "table"] as const;
export type ViewKey = (typeof VIEW_KEYS)[number];

/** Formats offered as a filter — AniList's seven less MUSIC, as before. */
export const FILTER_FORMATS = ["TV", "TV_SHORT", "MOVIE", "SPECIAL", "OVA", "ONA"] as const;
export const FILTER_STATUSES = ["RELEASING", "FINISHED", "NOT_YET_RELEASED"] as const;

/**
 * The source groups the filter offers. Each is an AniList source enum that
 * stands for itself plus its neighbours (see sourceGroupOf in browse.ts);
 * OTHER is every recorded source the six above do not claim.
 */
export const SOURCE_GROUPS = ["MANGA", "LIGHT_NOVEL", "ORIGINAL", "GAME", "NOVEL", "WEB_NOVEL", "OTHER"] as const;
export type SourceGroup = (typeof SOURCE_GROUPS)[number];

export type SequelFilter = "" | "new" | "sequel";

/** The month bucket for a show with no premiere date. */
export const MONTH_TBD = "tbd";

export interface BrowseState {
  q: string;
  /** In the order they were picked. */
  genres: readonly string[];
  /** "" = any. */
  format: string;
  status: string;
  source: SourceGroup | "";
  seq: SequelFilter;
  /** 0 = any; 1 = Monday … 7 = Sunday. */
  wd: number;
  /** "" = any; "YYYY-MM" or MONTH_TBD. */
  mon: string;
  hue: HueFamilyKey | "";
  sort: SortKey;
  view: ViewKey;
}

export const DEFAULT_STATE: BrowseState = {
  q: "",
  genres: [],
  format: "",
  status: "",
  source: "",
  seq: "",
  wd: 0,
  mon: "",
  hue: "",
  sort: "pop",
  view: "grid",
};

/** Every query key this page owns. Anything else in the URL is left alone. */
export const OWNED_PARAMS = [
  "q",
  "genre",
  "format",
  "status",
  "source",
  "seq",
  "wd",
  "mon",
  "hue",
  "sort",
  "view",
  "show",
] as const;

/** A search box is not a document: anything longer is not a title anyone typed. */
export const MAX_QUERY_LENGTH = 100;

/**
 * The sorts the page offered before, mapped to what they meant. `score` and
 * `title` survive as themselves; `format` (group by format) has no
 * counterpart, so it lands on the default.
 */
const LEGACY_SORT: Readonly<Record<string, SortKey>> = { format: "pop" };

const HUE_KEYS: readonly string[] = HUE_FAMILIES.map((f) => f.key);
const MONTH_PARAM = /^\d{4}-(0[1-9]|1[0-2])$/;

/** What the parser needs from a query: URLSearchParams satisfies it. */
export interface QuerySource {
  get(name: string): string | null;
}

function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | "" {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : "";
}

function parseGenres(value: string | null): string[] {
  if (!value) return [];
  const out: string[] = [];
  for (const raw of value.split(",")) {
    const g = raw.trim();
    if ((FILTER_GENRES as readonly string[]).includes(g) && !out.includes(g)) out.push(g);
  }
  return out;
}

function parseSort(value: string | null): SortKey {
  if (value === null) return DEFAULT_STATE.sort;
  return oneOf(value, SORT_KEYS) || LEGACY_SORT[value] || DEFAULT_STATE.sort;
}

/** The state a query describes. Never throws; anything unreadable is the default. */
export function parseBrowseState(query: QuerySource): BrowseState {
  const wd = Number(query.get("wd"));
  const mon = query.get("mon");
  const seq = query.get("seq");
  return {
    q: (query.get("q") ?? "").slice(0, MAX_QUERY_LENGTH),
    genres: parseGenres(query.get("genre")),
    format: oneOf(query.get("format"), FILTER_FORMATS),
    status: oneOf(query.get("status"), FILTER_STATUSES),
    source: oneOf(query.get("source"), SOURCE_GROUPS),
    seq: seq === "new" || seq === "sequel" ? seq : "",
    wd: Number.isInteger(wd) && wd >= 1 && wd <= 7 ? wd : 0,
    mon: mon === MONTH_TBD || (mon !== null && MONTH_PARAM.test(mon)) ? mon : "",
    hue: oneOf(query.get("hue"), HUE_KEYS) as HueFamilyKey | "",
    sort: parseSort(query.get("sort")),
    view: oneOf(query.get("view"), VIEW_KEYS) || DEFAULT_STATE.view,
  };
}

/** A server component's `searchParams` as a query: repeated keys read as their first value. */
export function queryFromRecord(record: Record<string, string | string[] | undefined>): QuerySource {
  return {
    get(name) {
      const v = record[name];
      if (Array.isArray(v)) return v[0] ?? null;
      return v ?? null;
    },
  };
}

/**
 * The query that describes `state`, on top of whatever else `base` carries.
 *
 * Defaults are left out, so the plain season page stays a plain URL. Keys
 * this page does not own (a campaign tag, say) are kept as they were.
 */
export function browseSearchParams(state: BrowseState, base: string = ""): URLSearchParams {
  const params = new URLSearchParams(base);
  for (const key of OWNED_PARAMS) params.delete(key);
  const q = state.q.trim();
  if (q) params.set("q", q);
  if (state.genres.length) params.set("genre", state.genres.join(","));
  if (state.format) params.set("format", state.format);
  if (state.status) params.set("status", state.status);
  if (state.source) params.set("source", state.source);
  if (state.seq) params.set("seq", state.seq);
  if (state.wd) params.set("wd", String(state.wd));
  if (state.mon) params.set("mon", state.mon);
  if (state.hue) params.set("hue", state.hue);
  if (state.sort !== DEFAULT_STATE.sort) params.set("sort", state.sort);
  if (state.view !== DEFAULT_STATE.view) params.set("view", state.view);
  return params;
}

/** `?…` for `state`, or "" when there is nothing to say. */
export function browseSearch(state: BrowseState, base: string = ""): string {
  const s = browseSearchParams(state, base).toString();
  return s ? `?${s}` : "";
}

/** Whether two states would render the same page (the search box compared as typed, trimmed). */
export function sameBrowseState(a: BrowseState, b: BrowseState): boolean {
  return (
    a.q.trim() === b.q.trim() &&
    a.genres.length === b.genres.length &&
    a.genres.every((g, i) => g === b.genres[i]) &&
    a.format === b.format &&
    a.status === b.status &&
    a.source === b.source &&
    a.seq === b.seq &&
    a.wd === b.wd &&
    a.mon === b.mon &&
    a.hue === b.hue &&
    a.sort === b.sort &&
    a.view === b.view
  );
}

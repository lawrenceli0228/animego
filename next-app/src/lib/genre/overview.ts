// The two API answers the genre page reads, checked on arrival.
//
//   GET /api/anime/genre-overview?genre=Action   → the hub
//   GET /api/anime/browse?genre=Action&…         → a grid page
//
// Neither is trusted to have the shape it promises. A field that is missing,
// mistyped or out of range comes out empty rather than throwing: the page then
// draws less (a rail with nothing in it is left out, a tile with no count is
// dropped), never a 500. Unknown decade keys and genres the site has no page
// for are dropped too — every tile is a link, and a link must lead somewhere.
//
// Pure: no React, no DOM.

import { FILTER_GENRES, type FilterGenre } from "@/lib/contentLabels";
import type { SeasonalAnime } from "@/lib/types";
import type { CoverWire } from "./tiles";
import { DECADE_KEYS, LIST_KEYS, isDecadeKey, type DecadeKey, type ListKey } from "./views";

export interface GenreOverviewList {
  count: number;
  items: SeasonalAnime[];
}

export interface GenreOverview {
  genre: string;
  total: number;
  airing: number;
  /** The first release year counted as recent, as the API decided it. */
  recentFrom: number | null;
  lists: Record<ListKey, GenreOverviewList>;
  /** Newest first. */
  decades: Array<{ key: DecadeKey; count: number; covers: CoverWire[] }>;
  related: Array<{ genre: FilterGenre; count: number; covers: CoverWire[] }>;
  studios: Array<{ studio: string; count: number; covers: CoverWire[] }>;
}

type Rec = Record<string, unknown>;

const isRecord = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

/** A non-negative whole count; anything else is 0. */
export function countOf(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** Rows: objects with a numeric id. */
export function rowsOf(v: unknown): SeasonalAnime[] {
  if (!Array.isArray(v)) return [];
  return v.filter((r): r is SeasonalAnime => isRecord(r) && typeof r.anilistId === "number");
}

function coversOf(v: unknown): CoverWire[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((c): c is Rec => isRecord(c) && typeof c.anilistId === "number")
    .map((c) => ({
      anilistId: c.anilistId as number,
      coverImageUrl: typeof c.coverImageUrl === "string" ? c.coverImageUrl : null,
      posterAccent: typeof c.posterAccent === "string" ? c.posterAccent : null,
    }));
}

function listOf(v: unknown): GenreOverviewList {
  if (!isRecord(v)) return { count: 0, items: [] };
  return { count: countOf(v.count), items: rowsOf(v.items) };
}

const GENRES = new Set<string>(FILTER_GENRES);

/** The overview inside a `{ data }` envelope (or the bare object); null when it is not one. */
export function parseOverview(raw: unknown, genre: FilterGenre): GenreOverview | null {
  const body = isRecord(raw) && isRecord(raw.data) ? raw.data : raw;
  if (!isRecord(body)) return null;

  const lists = isRecord(body.lists) ? body.lists : {};
  const parsedLists = Object.fromEntries(LIST_KEYS.map((k) => [k, listOf(lists[k])])) as Record<
    ListKey,
    GenreOverviewList
  >;

  const decades = (Array.isArray(body.decades) ? body.decades : [])
    .filter((d): d is Rec => isRecord(d) && typeof d.key === "string" && isDecadeKey(d.key))
    .map((d) => ({ key: d.key as DecadeKey, count: countOf(d.count), covers: coversOf(d.covers) }))
    .filter((d) => d.count > 0)
    .filter((d, i, all) => all.findIndex((o) => o.key === d.key) === i)
    .sort((a, b) => DECADE_KEYS.indexOf(a.key) - DECADE_KEYS.indexOf(b.key));

  const related = (Array.isArray(body.related) ? body.related : [])
    .filter((r): r is Rec => isRecord(r) && typeof r.genre === "string" && GENRES.has(r.genre) && r.genre !== genre)
    .map((r) => ({ genre: r.genre as FilterGenre, count: countOf(r.count), covers: coversOf(r.covers) }))
    .filter((r) => r.count > 0)
    .filter((r, i, all) => all.findIndex((o) => o.genre === r.genre) === i);

  const studios = (Array.isArray(body.studios) ? body.studios : [])
    .filter((s): s is Rec => isRecord(s) && typeof s.studio === "string" && s.studio.trim() !== "")
    .map((s) => ({ studio: (s.studio as string).trim(), count: countOf(s.count), covers: coversOf(s.covers) }))
    .filter((s) => s.count > 0)
    .filter((s, i, all) => all.findIndex((o) => o.studio === s.studio) === i);

  const recentFrom = body.recentFrom;
  return {
    genre: typeof body.genre === "string" ? body.genre : genre,
    total: countOf(body.total),
    airing: countOf(body.airing),
    recentFrom: typeof recentFrom === "number" && Number.isInteger(recentFrom) ? recentFrom : null,
    lists: parsedLists,
    decades,
    related,
    studios,
  };
}

export interface BrowsePage {
  rows: SeasonalAnime[];
  /** Every title the filter matches, not just this page. */
  total: number;
}

/** One page of /api/anime/browse out of its envelope; empty when it is not one. */
export function parseBrowsePage(raw: unknown): BrowsePage {
  if (!isRecord(raw)) return { rows: [], total: 0 };
  const pagination = isRecord(raw.pagination) ? raw.pagination : {};
  return { rows: rowsOf(raw.data), total: countOf(pagination.total) };
}

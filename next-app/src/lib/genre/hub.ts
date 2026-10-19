// The hub view, assembled on the server from the overview: what the client
// tree is handed as props.
//
// Everything that can be decided once is decided here — which rails have
// enough in them to show, the top ten, each tile's three covers — so the
// browser receives the page as it will be drawn and the server HTML and the
// hydrated page cannot disagree about any of it.
//
// Pure: no React, no DOM.

import type { FilterGenre } from "@/lib/contentLabels";
import type { Lang } from "@/lib/i18n/lang";
import { toGenreItems, type GenreItem } from "./items";
import type { GenreOverview } from "./overview";
import { chooseTileCovers, tileCandidates, type TileCover } from "./tiles";
import { RAIL_KEYS, type DecadeKey, type RailKey } from "./views";

/** Cards on a rail. */
export const RAIL_SIZE = 6;
/** A rail with fewer than this is not a rail: it is left out. */
export const MIN_RAIL_ITEMS = 4;
/** The ranking beside the rails. */
export const TOP_SIZE = 10;
/** Tiles in a row. */
export const MAX_TILES = 7;

export interface GenreRail {
  key: RailKey;
  /** Every title in the slice, not only the six shown. */
  count: number;
  items: GenreItem[];
}

interface TileBase {
  count: number;
  covers: TileCover[];
  hue: number | null;
}

export interface DecadeTile extends TileBase {
  kind: "decade";
  decade: DecadeKey;
}

export interface RelatedTile extends TileBase {
  kind: "with";
  genre: FilterGenre;
}

export interface StudioTile extends TileBase {
  kind: "studio";
  studio: string;
}

export type GenreTile = DecadeTile | RelatedTile | StudioTile;

export interface GenreHubData {
  kind: "hub";
  total: number;
  airing: number;
  rails: GenreRail[];
  top: GenreItem[];
  decades: DecadeTile[];
  related: RelatedTile[];
  studios: StudioTile[];
}

/** What the hub shows when the overview could not be had: the heading and the strip, nothing else. */
export const EMPTY_HUB: GenreHubData = {
  kind: "hub",
  total: 0,
  airing: 0,
  rails: [],
  top: [],
  decades: [],
  related: [],
  studios: [],
};

export function buildHubData(overview: GenreOverview | null, lang: Lang): GenreHubData {
  if (!overview) return EMPTY_HUB;

  const rails: GenreRail[] = [];
  for (const key of RAIL_KEYS) {
    const list = overview.lists[key];
    const items = toGenreItems(list.items, lang).slice(0, RAIL_SIZE);
    if (items.length >= MIN_RAIL_ITEMS) rails.push({ key, count: list.count, items });
  }

  const decades = overview.decades.slice(0, MAX_TILES);
  const related = overview.related.slice(0, MAX_TILES);
  const studios = overview.studios.slice(0, MAX_TILES);
  const chosen = chooseTileCovers([
    ...decades.map((d) => tileCandidates(d.covers)),
    ...related.map((r) => tileCandidates(r.covers)),
    ...studios.map((s) => tileCandidates(s.covers)),
  ]);
  const at = (i: number) => chosen[i] ?? { covers: [], hue: null };

  return {
    kind: "hub",
    total: overview.total,
    airing: overview.airing,
    rails,
    top: toGenreItems(overview.lists.top.items, lang).slice(0, TOP_SIZE),
    decades: decades.map((d, i) => ({ kind: "decade", decade: d.key, count: d.count, ...at(i) })),
    related: related.map((r, i) => ({ kind: "with", genre: r.genre, count: r.count, ...at(decades.length + i) })),
    studios: studios.map((s, i) => ({
      kind: "studio",
      studio: s.studio,
      count: s.count,
      ...at(decades.length + related.length + i),
    })),
  };
}

// Which covers each tile shows.
//
// The three tile rows (decades, genres that go with this one, studios) each
// fan out three covers, and the same famous show is a candidate for many of
// them: a 2010s action hit is also in the 2010s tile, the fantasy tile and
// its studio's tile. Shown three times over, the rows read as one picture
// repeated. So the tiles are walked in display order — decades, then related
// genres, then studios — and each takes up to three covers no earlier tile has
// used, topping up from the used ones only when it has nothing new to show.
// A tile's ground takes the hue of its first cover.
//
// Pure: no React, no DOM.

import { animeHue } from "@/lib/home/tone";

/** A cover as the API offers it for a tile. */
export interface CoverWire {
  anilistId: number;
  coverImageUrl: string | null;
  posterAccent: string | null;
}

export interface TileCover {
  id: number;
  src: string;
  /** OKLCH hue of the poster accent, or null for a neutral one. */
  hue: number | null;
}

export interface ChosenCovers {
  covers: TileCover[];
  /** The tile's ground: its first cover's hue; null (neutral) with no cover. */
  hue: number | null;
}

/** Covers per tile — the fan's three cards. */
export const COVERS_PER_TILE = 3;

/** A tile's candidates, in the API's order: one per show, only shows with a cover. */
export function tileCandidates(wire: readonly CoverWire[] | null | undefined): TileCover[] {
  const out: TileCover[] = [];
  const seen = new Set<number>();
  for (const c of wire ?? []) {
    if (!c || typeof c.anilistId !== "number" || seen.has(c.anilistId)) continue;
    const src = typeof c.coverImageUrl === "string" ? c.coverImageUrl.trim() : "";
    if (!src) continue;
    seen.add(c.anilistId);
    out.push({ id: c.anilistId, src, hue: animeHue(c.posterAccent) });
  }
  return out;
}

/** Every tile's covers, the tiles given in display order. */
export function chooseTileCovers(
  tiles: readonly (readonly TileCover[])[],
  per: number = COVERS_PER_TILE,
): ChosenCovers[] {
  const used = new Set<number>();
  return tiles.map((candidates) => {
    const fresh = candidates.filter((c) => !used.has(c.id)).slice(0, per);
    const topUp = candidates.filter((c) => !fresh.includes(c)).slice(0, per - fresh.length);
    const covers = [...fresh, ...topUp];
    for (const c of covers) used.add(c.id);
    return { covers, hue: covers[0]?.hue ?? null };
  });
}

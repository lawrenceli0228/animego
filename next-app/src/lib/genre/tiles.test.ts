import { describe, expect, test } from "bun:test";

import { animeHue } from "@/lib/home/tone";
import { chooseTileCovers, tileCandidates, type TileCover } from "./tiles";

const c = (id: number, hue: number | null = null): TileCover => ({ id, src: `/c/${id}.jpg`, hue });
const ids = (covers: readonly TileCover[]) => covers.map((x) => x.id);

describe("tileCandidates", () => {
  test("one per show, only shows with a cover, the accent as a hue", () => {
    const got = tileCandidates([
      { anilistId: 1, coverImageUrl: "https://x/1.jpg", posterAccent: "#3b6fe0" },
      { anilistId: 2, coverImageUrl: null, posterAccent: null },
      { anilistId: 3, coverImageUrl: "  ", posterAccent: null },
      { anilistId: 1, coverImageUrl: "https://x/1b.jpg", posterAccent: null },
      { anilistId: 4, coverImageUrl: "https://x/4.jpg", posterAccent: "#8b5cf6" },
    ]);
    expect(ids(got)).toEqual([1, 4]);
    expect(got[0]?.hue).toBe(animeHue("#3b6fe0"));
    // The brand fallback accent is not a colour: neutral.
    expect(got[1]?.hue).toBeNull();
  });

  test("nothing in, nothing out", () => {
    expect(tileCandidates(null)).toEqual([]);
    expect(tileCandidates(undefined)).toEqual([]);
  });
});

describe("chooseTileCovers", () => {
  test("each tile takes covers no earlier tile used", () => {
    const got = chooseTileCovers([
      [c(1), c(2), c(3), c(4)],
      [c(1), c(2), c(5), c(6), c(7)],
      [c(2), c(8), c(9)],
    ]);
    expect(got.map((t) => ids(t.covers))).toEqual([
      [1, 2, 3],
      [5, 6, 7],
      [8, 9, 2],
    ]);
  });

  test("with nothing new, a tile tops up from the used ones, in its own order", () => {
    const got = chooseTileCovers([
      [c(1), c(2), c(3)],
      [c(3), c(1), c(2), c(4)],
    ]);
    expect(ids(got[1]?.covers ?? [])).toEqual([4, 3, 1]);
  });

  test("a tile with fewer than three candidates shows what it has; none shows none", () => {
    const got = chooseTileCovers([[c(1)], []]);
    expect(ids(got[0]?.covers ?? [])).toEqual([1]);
    expect(got[1]).toEqual({ covers: [], hue: null });
  });

  test("the ground is the first chosen cover's hue", () => {
    const got = chooseTileCovers([
      [c(1, 250), c(2, 30)],
      [c(1, 250), c(3, 120)],
    ]);
    expect(got[0]?.hue).toBe(250);
    expect(got[1]?.hue).toBe(120);
  });

  test("the walk is in display order across rows: decades, then related, then studios", () => {
    // The hub hands the three rows in as one list; a show the decades used is
    // not the first choice of a related genre's tile.
    const decades = [[c(10), c(11), c(12)]];
    const related = [[c(10), c(13), c(14), c(15)]];
    const studios = [[c(13), c(16)]];
    const got = chooseTileCovers([...decades, ...related, ...studios]);
    expect(got.map((t) => ids(t.covers))).toEqual([
      [10, 11, 12],
      [13, 14, 15],
      [16, 13],
    ]);
  });
});

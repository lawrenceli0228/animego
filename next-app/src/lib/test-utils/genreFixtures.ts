// Test helpers for lib/genre and components/genre: API rows and a genre
// overview in exactly the wire shape the API answers with
// (GET /api/anime/genre-overview, GET /api/anime/browse), so each test states
// only what it is about.
//
// Not a test file itself (no `.test.` in the name), and imported only by them.

import type { SeasonalAnime } from "@/lib/types";

export const ANILIST_COVER = (id: number) => `https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx${id}-test.jpg`;

/** One browse / overview row: the seasonal item wire shape. */
export function row(overrides: Partial<SeasonalAnime> & { anilistId: number }): SeasonalAnime {
  const id = overrides.anilistId;
  return {
    titleRomaji: `Test Show ${id}`,
    titleEnglish: null,
    titleNative: null,
    titleChinese: `测试番 ${id}`,
    titleHant: null,
    coverImageUrl: null,
    coverImageColor: null,
    posterAccent: null,
    averageScore: 70,
    episodes: 12,
    season: "SPRING",
    seasonYear: 2019,
    status: "FINISHED",
    format: "TV",
    genres: ["Action"],
    bangumiScore: null,
    description: null,
    studio: null,
    nextAiringAt: null,
    nextAiringEpisode: null,
    popularity: 10_000,
    favourites: 100,
    source: "MANGA",
    startDate: "2019-04-05",
    duration: 24,
    isSequel: null,
    ...overrides,
  };
}

export interface WireCover {
  anilistId: number;
  coverImageUrl: string | null;
  posterAccent: string | null;
}

export const cover = (id: number, posterAccent: string | null = null): WireCover => ({
  anilistId: id,
  coverImageUrl: ANILIST_COVER(id),
  posterAccent,
});

/** Rows `from` … `from + n - 1`. */
export function rows(from: number, n: number, overrides: Partial<SeasonalAnime> = {}): SeasonalAnime[] {
  return Array.from({ length: n }, (_, i) => row({ anilistId: from + i, popularity: 100_000 - i, ...overrides }));
}

/** An overview for Action with every list, three decades, two related genres and two studios. */
export function overviewWire(): Record<string, unknown> {
  return {
    genre: "Action",
    total: 5241,
    airing: 84,
    recentFrom: 2020,
    lists: {
      airing: { count: 84, items: rows(100, 6, { status: "RELEASING", seasonYear: 2026, season: "FALL" }) },
      popular: { count: 5241, items: rows(200, 6) },
      recent: { count: 1200, items: rows(300, 6, { seasonYear: 2024 }) },
      classic: { count: 2100, items: rows(400, 3, { seasonYear: 1998 }) },
      top: { count: 3000, items: rows(500, 10, { averageScore: 90 }) },
    },
    decades: [
      { key: "2020", count: 1200, covers: [cover(1, "#3b6fe0"), cover(2), cover(3), cover(4)] },
      { key: "2010", count: 1600, covers: [cover(1), cover(2), cover(5), cover(6)] },
      { key: "old", count: 40, covers: [] },
    ],
    related: [
      { genre: "Fantasy", count: 900, covers: [cover(1), cover(7, "#d9483b"), cover(8), cover(9)] },
      { genre: "Sci-Fi", count: 800, covers: [cover(10), cover(11), cover(12)] },
    ],
    studios: [
      { studio: "Toei Animation", count: 300, covers: [cover(13), cover(14), cover(15)] },
      { studio: "MAPPA", count: 120, covers: [cover(16)] },
    ],
  };
}

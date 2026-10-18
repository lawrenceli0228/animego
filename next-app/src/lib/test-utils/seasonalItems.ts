// Test helpers for lib/seasonal: a browse item with every field set to something
// unremarkable, so each test states only what it is about.
//
// Not a test file itself (no `.test.` in the name), and imported only by them.

import type { SeasonalItem } from "@/lib/seasonal/model";

/** Friday 2026-10-16 12:00 UTC = 20:00 in Beijing. The clock most tests read. */
export const NOW = Date.UTC(2026, 9, 16, 12, 0);

export const HOUR_MS = 3_600_000;

export function item(overrides: Partial<SeasonalItem> & { id: number }): SeasonalItem {
  return {
    title: `测试番 ${overrides.id}`,
    haystack: `测试番 ${overrides.id}`.toLowerCase(),
    rank: overrides.id,
    titleRank: overrides.id,
    cover: null,
    hue: null,
    score: null,
    bangumi: null,
    format: "TV",
    status: "RELEASING",
    episodes: null,
    duration: null,
    genres: [],
    studio: null,
    next: null,
    popularity: null,
    favourites: null,
    source: null,
    start: null,
    sequel: null,
    synopsis: "",
    ...overrides,
  };
}

// The rankings' catalogue (/top, /top/{year}) for top-100.spec.ts: a 2019 no
// other spec seeds a rankable show in, and a 1955 for the 更早 menu.
//
//   27 rankable 2019 shows — scores falling in pairs, so a tie is decided by
//   popularity, and one pair tied on both, decided by id; TVs, movies and
//   ONAs, all four seasons, every one Action and every third Comedy; one film
//   with no season (its year is its premiere's) and one show with no format;
//   and five that must never be ranked: a 9.9 tracked by 999 users, a music
//   video, an adult title, one with no score and one scored 0.
//
// Seeded by globalSetup, before any spec runs, and not by the spec. The list
// of years that have a ranking is one answer for the whole site, cached for
// minutes by go-api and by Next's data cache, and other specs ask for it
// before this one runs (the hub sitemap, which sitemap-shards reads, lists the
// rankings' years). Seeded inside the spec, the years 2019 and 1955 were not
// in that cached answer when the spec came to read it, and the strip had no
// 更早 for them. Seeded first, every answer anyone caches already has them.
//
// The titles share no word with any other spec's: search.spec looks for its
// probes among everything a query matches.

import { getSql } from "./pg";

export const TOP_BASE_ID = 990_800_000;
export const TOP_YEAR = 2019;
export const TOP_OLD_YEAR = 1955;
/** A year nothing anywhere ranks in. */
export const TOP_NO_RANKING_YEAR = 1901;

const SEASONS = ["WINTER", "SPRING", "SUMMER", "FALL"] as const;

export interface TopShow {
  id: number;
  score: number | null;
  popularity: number;
  format: string | null;
  season: string | null;
  seasonYear: number | null;
  startDate: string | null;
  genres: string[];
  adult?: boolean;
}

function mainShow(i: number): TopShow {
  return {
    id: TOP_BASE_ID + i,
    score: 99 - Math.floor(i / 2),
    // Shows 2 and 3 tie on popularity too: their order is their ids'.
    popularity: i === 3 ? 50_000 - 2 * 100 : 50_000 - i * 100,
    format: i % 5 === 1 ? "MOVIE" : i % 5 === 3 ? "ONA" : "TV",
    season: SEASONS[i % 4] ?? null,
    seasonYear: TOP_YEAR,
    startDate: `${TOP_YEAR}-0${1 + (i % 4) * 3}-05`,
    genres: i % 3 === 0 ? ["Action", "Comedy"] : ["Action"],
  };
}

/** Every show 2019's ranking lists. */
export const TOP_RANKED: TopShow[] = [
  ...Array.from({ length: 25 }, (_, i) => mainShow(i)),
  // A film with no season: filed under the year it premiered.
  { id: TOP_BASE_ID + 30, score: 96, popularity: 99_999, format: "MOVIE", season: null, seasonYear: null, startDate: `${TOP_YEAR}-08-01`, genres: ["Drama"] },
  // No format: ranked all the same.
  { id: TOP_BASE_ID + 31, score: 70, popularity: 20_000, format: null, season: "SPRING", seasonYear: TOP_YEAR, startDate: null, genres: ["Drama"] },
];

/** 2019's shows no ranking may list. */
export const TOP_NEVER: TopShow[] = [
  { id: TOP_BASE_ID + 40, score: 99, popularity: 999, format: "TV", season: "SPRING", seasonYear: TOP_YEAR, startDate: null, genres: ["Action"] },
  { id: TOP_BASE_ID + 41, score: 99, popularity: 90_000, format: "MUSIC", season: "SPRING", seasonYear: TOP_YEAR, startDate: null, genres: ["Action"] },
  { id: TOP_BASE_ID + 42, score: 99, popularity: 90_000, format: "TV", season: "SPRING", seasonYear: TOP_YEAR, startDate: null, genres: ["Action"], adult: true },
  { id: TOP_BASE_ID + 43, score: null, popularity: 90_000, format: "TV", season: "SPRING", seasonYear: TOP_YEAR, startDate: null, genres: ["Action"] },
  { id: TOP_BASE_ID + 44, score: 0, popularity: 90_000, format: "TV", season: "SPRING", seasonYear: TOP_YEAR, startDate: null, genres: ["Action"] },
];

/** 1955's ranking. */
export const TOP_OLD: TopShow[] = [
  { id: TOP_BASE_ID + 50, score: 80, popularity: 5_000, format: "TV", season: "SPRING", seasonYear: TOP_OLD_YEAR, startDate: null, genres: ["Drama"] },
  { id: TOP_BASE_ID + 51, score: 79, popularity: 5_000, format: "MOVIE", season: "FALL", seasonYear: TOP_OLD_YEAR, startDate: null, genres: ["Drama"] },
];

const ALL = [...TOP_RANKED, ...TOP_NEVER, ...TOP_OLD];

/** A show's title as the page shows it. */
export const topTitle = (id: number) => `排位样例 ${id - TOP_BASE_ID}`;

/** Insert (or refresh) every show and its genres. Idempotent. */
export async function seedTopRankings(): Promise<void> {
  const sql = getSql();
  for (const s of ALL) {
    await sql`
      INSERT INTO anime_cache (
        anilist_id, title_romaji, title_chinese, average_score, popularity, format, season, season_year,
        start_date, status, episodes, is_adult, bangumi_version, trailer_checked_at, detail_fetched_at,
        facts_checked_at, cached_at
      )
      VALUES (
        ${s.id}, ${`Ranking Fixture ${s.id - TOP_BASE_ID}`}, ${topTitle(s.id)}, ${s.score}, ${s.popularity}, ${s.format},
        ${s.season}, ${s.seasonYear}, ${s.startDate}, 'FINISHED', 12, ${s.adult ?? false}, 2, now(), now(), now(), now()
      )
      ON CONFLICT (anilist_id) DO UPDATE SET
        title_romaji = EXCLUDED.title_romaji, title_chinese = EXCLUDED.title_chinese,
        average_score = EXCLUDED.average_score, popularity = EXCLUDED.popularity, format = EXCLUDED.format,
        season = EXCLUDED.season, season_year = EXCLUDED.season_year, start_date = EXCLUDED.start_date,
        is_adult = EXCLUDED.is_adult, updated_at = now()
    `;
    for (const g of s.genres) {
      await sql`INSERT INTO anime_genres (anime_id, genre) VALUES (${s.id}, ${g}) ON CONFLICT (anime_id, genre) DO NOTHING`;
    }
  }
}

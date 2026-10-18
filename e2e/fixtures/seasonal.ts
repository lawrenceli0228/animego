// Seasonal page fixtures: whole seasons, seeded the way the AniList sync and
// the detail fetch leave them, so /api/anime/seasonal answers from Postgres
// alone.
//
// What makes a row look finished to the stack — and keeps the background
// sweeps off it — is the same set of stamps ensureAnimeDetail writes:
// detail_fetched_at, facts_checked_at and trailer_checked_at. A seasonal
// fixture whose rows the facts sweep picked up would have AniList asked about
// ids it has never heard of, and the listing could change under the spec.
// bangumi_version 2 does the same for the Bangumi enrichment, which would
// otherwise try to rewrite the fixture titles.
//
// The seasons these fixtures use are years no real data has (2098, 2099), so
// nothing here can collide with the sandbox's own catalogue, and the warm path
// of the endpoint (rows exist → no AniList call) is the only path taken.

import { getSql } from "./pg";

export type SeasonEnum = "WINTER" | "SPRING" | "SUMMER" | "FALL";

export interface SeedSeasonRow {
  anilistId: number;
  season: SeasonEnum;
  seasonYear: number;
  titleChinese: string;
  titleRomaji: string;
  titleNative?: string | null;
  titleEnglish?: string | null;
  posterAccent?: string | null;
  coverImageUrl?: string | null;
  averageScore?: number | null;
  bangumiScore?: number | null;
  episodes?: number | null;
  status: string;
  format: string;
  popularity?: number | null;
  favourites?: number | null;
  source?: string | null;
  /** `YYYY-MM-DD`. */
  startDate?: string | null;
  duration?: number | null;
  /** ISO instant; comes as a pair with nextAiringEpisode. */
  nextAiringAt?: string | null;
  nextAiringEpisode?: number | null;
  genres?: readonly string[];
  /** The main studio. */
  studio?: string | null;
  /** Gives the row one PREQUEL relation of this AniList format (TV → a sequel; MANGA → not). */
  prequelFormat?: string | null;
  description?: string | null;
}

/** The PREQUEL target ids: never cached, never rendered, just an edge's far end. */
const PREQUEL_ID_OFFSET = 5_000_000;

/**
 * Insert (or refresh) every row, its genres, its main studio and its prequel.
 * Idempotent, and safe to run twice at once for the same rows: every child
 * insert is behind its natural key, nothing is deleted first.
 */
export async function seedSeason(rows: readonly SeedSeasonRow[]): Promise<void> {
  const sql = getSql();
  for (const r of rows) {
    if (((r.nextAiringAt ?? null) === null) !== ((r.nextAiringEpisode ?? null) === null)) {
      throw new Error(`seedSeason(${r.anilistId}): nextAiringAt and nextAiringEpisode come as a pair`);
    }
    await sql`
      INSERT INTO anime_cache (
        anilist_id, title_romaji, title_english, title_native, title_chinese,
        cover_image_url, poster_accent, average_score, bangumi_score, episodes,
        status, format, season, season_year, popularity, favourites, source,
        start_date, duration, next_airing_at, next_airing_episode, description,
        bangumi_version, trailer_checked_at, detail_fetched_at, facts_checked_at, cached_at
      )
      VALUES (
        ${r.anilistId}, ${r.titleRomaji}, ${r.titleEnglish ?? null}, ${r.titleNative ?? null}, ${r.titleChinese},
        ${r.coverImageUrl ?? null}, ${r.posterAccent ?? null}, ${r.averageScore ?? null}, ${r.bangumiScore ?? null},
        ${r.episodes ?? null}, ${r.status}, ${r.format}, ${r.season}, ${r.seasonYear},
        ${r.popularity ?? null}, ${r.favourites ?? null}, ${r.source ?? null},
        ${r.startDate ?? null}, ${r.duration ?? null}, ${r.nextAiringAt ?? null}, ${r.nextAiringEpisode ?? null},
        ${r.description ?? null}, 2, now(), now(), now(), now()
      )
      ON CONFLICT (anilist_id) DO UPDATE SET
        title_romaji = EXCLUDED.title_romaji,
        title_english = EXCLUDED.title_english,
        title_native = EXCLUDED.title_native,
        title_chinese = EXCLUDED.title_chinese,
        cover_image_url = EXCLUDED.cover_image_url,
        poster_accent = EXCLUDED.poster_accent,
        average_score = EXCLUDED.average_score,
        bangumi_score = EXCLUDED.bangumi_score,
        episodes = EXCLUDED.episodes,
        status = EXCLUDED.status,
        format = EXCLUDED.format,
        season = EXCLUDED.season,
        season_year = EXCLUDED.season_year,
        popularity = EXCLUDED.popularity,
        favourites = EXCLUDED.favourites,
        source = EXCLUDED.source,
        start_date = EXCLUDED.start_date,
        duration = EXCLUDED.duration,
        next_airing_at = EXCLUDED.next_airing_at,
        next_airing_episode = EXCLUDED.next_airing_episode,
        description = EXCLUDED.description,
        bangumi_version = 2,
        trailer_checked_at = now(),
        detail_fetched_at = now(),
        facts_checked_at = now(),
        cached_at = now(),
        updated_at = now()
    `;
    for (const genre of r.genres ?? []) {
      await sql`
        INSERT INTO anime_genres (anime_id, genre) VALUES (${r.anilistId}, ${genre})
        ON CONFLICT (anime_id, genre) DO NOTHING
      `;
    }
    if (r.studio) {
      await sql`
        INSERT INTO anime_studios (anime_id, studio, is_main) VALUES (${r.anilistId}, ${r.studio}, true)
        ON CONFLICT (anime_id, studio) DO UPDATE SET is_main = true
      `;
    }
    if (r.prequelFormat) {
      await sql`
        INSERT INTO anime_relations (anime_id, anilist_id, relation_type, title, cover_image_url, format)
        SELECT ${r.anilistId}, ${r.anilistId + PREQUEL_ID_OFFSET}, 'PREQUEL', 'E2E prequel', '/mascot-wink.png', ${r.prequelFormat}
        WHERE NOT EXISTS (
          SELECT 1 FROM anime_relations WHERE anime_id = ${r.anilistId} AND relation_type = 'PREQUEL'
        )
      `;
    }
  }
}

/** Drop the rows; genres, studios and relations go with them (ON DELETE CASCADE). */
export async function removeSeasonFixture(ids: readonly number[]): Promise<void> {
  if (ids.length === 0) return;
  const sql = getSql();
  await sql`DELETE FROM anime_cache WHERE anilist_id IN ${sql([...ids])}`;
}

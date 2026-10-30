-- top.sql — the Top 100 pages, behind GET /api/anime/top and
-- GET /api/anime/top/years: the all-time ranking, one year's, and the
-- years that have one.
--
-- A title is ranked when it is not adult (by the column and by the genre,
-- as every listing excludes it -- see GetSeasonalAnime), has a score, is
-- tracked by at least min_popularity AniList users, and is not a music
-- video.  The popularity floor is /browse's sort=score floor (passed from
-- browseScoreMinPopularity): below it an average rests on a handful of
-- ratings, and a handful of 9s would head the ranking above everything
-- people watched.  A music video is a three-minute clip scored by its
-- fans; ranked, it would sit among the series it is the opening of.  A
-- title with no format at all is ranked like any other.  The two queries
-- below repeat the rule and must change together.

-- name: TopAnime :many
-- One ranking of at most row_limit titles, best first.  Every filter is
-- optional (NULL meaning "not asked"); the ranking is re-cut inside the
-- filter, so its first title is first among what the filter keeps.
--
-- The year is BrowseAnime's -- COALESCE(season_year, year of start_date),
-- byte-identical to the expression migration 0039 indexes, or the planner
-- will not use the index.  season narrows a year to one quarter by the
-- season AniList assigned; a title without one (most films) has no
-- quarter and is left out of every quarter.  The genre is an EXISTS for
-- the reason BrowseAnime's genre is: written ($n IS NULL OR EXISTS ...)
-- it keeps the statement planned for each request's own arguments (see
-- TestTop_PG_PlannedForTheirArguments).
--
-- average_score DESC, popularity DESC, anilist_id is a total order over
-- the ranked titles (neither sort key can be NULL past the WHERE), so a
-- tie on the score goes to the more popular title, and a tie on both to
-- the older id: the same request always ranks the same way.
--
-- The ranking is chosen first, on the ids and the sort keys alone, and
-- only its rows are projected, as in BrowseAnime: the projection's
-- per-row subqueries then run a hundred times rather than once per
-- ranked title.  The projection is BrowseAnime's, column for column, so
-- the handler sends these rows through the same item type (see
-- topItemFromRow, which stops compiling if they drift).
WITH ranked AS (
    SELECT anilist_id
    FROM anime_cache
    WHERE NOT is_adult
      AND NOT EXISTS (
            SELECT 1 FROM anime_genres
            WHERE anime_genres.anime_id = anime_cache.anilist_id
              AND anime_genres.genre = 'Hentai'
          )
      AND average_score > 0
      AND popularity >= sqlc.arg(min_popularity)::int
      AND format IS DISTINCT FROM 'MUSIC'
      AND (sqlc.narg(release_year)::int IS NULL
           OR COALESCE(season_year, EXTRACT(YEAR FROM start_date)::int) = sqlc.narg(release_year)::int)
      AND (sqlc.narg(format)::text IS NULL OR format = sqlc.narg(format)::text)
      AND (sqlc.narg(season)::text IS NULL OR season = sqlc.narg(season)::text)
      AND (sqlc.narg(genre)::text IS NULL OR EXISTS (
            SELECT 1 FROM anime_genres g
            WHERE g.anime_id = anime_cache.anilist_id AND g.genre = sqlc.narg(genre)::text))
    ORDER BY average_score DESC, popularity DESC, anilist_id
    LIMIT sqlc.arg(row_limit)::int
)
SELECT
    anime_cache.anilist_id,
    title_romaji,
    title_english,
    title_native,
    title_chinese,
    title_hant,
    title_hant_source,
    title_hant_seo,
    cover_image_url,
    banner_image_url,
    cover_image_color,
    poster_accent,
    average_score,
    bangumi_score,
    episodes,
    season,
    season_year,
    status,
    format,
    description,
    description_cn,
    description_cn_source,
    description_hant,
    description_hant_source,
    ARRAY(
        SELECT g.genre
        FROM anime_genres g
        WHERE g.anime_id = anime_cache.anilist_id
        ORDER BY g.genre
    )::text[] AS genres,
    (SELECT count(*)::bigint
     FROM episode_comments discussion
     WHERE discussion.anilist_id = anime_cache.anilist_id
    ) AS discussion_count,
    trailer_id,
    trailer_site,
    ARRAY(
        SELECT s.studio
        FROM anime_studios s
        WHERE s.anime_id = anime_cache.anilist_id AND s.is_main
        ORDER BY s.studio
        LIMIT 1
    )::text[] AS main_studio,
    next_airing_at,
    next_airing_episode,
    popularity,
    favourites,
    source,
    start_date,
    duration,
    EXISTS (
        SELECT 1 FROM anime_relations r
        WHERE r.anime_id = anime_cache.anilist_id
          AND r.relation_type = 'PREQUEL'
          AND r.format IN ('TV', 'TV_SHORT', 'MOVIE', 'SPECIAL', 'OVA', 'ONA', 'MUSIC')
    ) AS is_sequel,
    (detail_fetched_at IS NOT NULL)::boolean AS relations_known
FROM ranked
JOIN anime_cache ON anime_cache.anilist_id = ranked.anilist_id
ORDER BY anime_cache.average_score DESC, anime_cache.popularity DESC, anime_cache.anilist_id;

-- name: ListTopYears :many
-- Every release year with a ranked title, newest first, and how many it
-- has: the years a /top/{year} page exists for.  Same rule and same year
-- expression as TopAnime; a title with no year is in no year's ranking.
SELECT COALESCE(season_year, EXTRACT(YEAR FROM start_date)::int)::int AS release_year, count(*)::bigint AS n
FROM anime_cache
WHERE NOT is_adult
  AND NOT EXISTS (
        SELECT 1 FROM anime_genres
        WHERE anime_genres.anime_id = anime_cache.anilist_id
          AND anime_genres.genre = 'Hentai'
      )
  AND average_score > 0
  AND popularity >= sqlc.arg(min_popularity)::int
  AND format IS DISTINCT FROM 'MUSIC'
  AND COALESCE(season_year, EXTRACT(YEAR FROM start_date)::int) IS NOT NULL
GROUP BY 1
ORDER BY 1 DESC;

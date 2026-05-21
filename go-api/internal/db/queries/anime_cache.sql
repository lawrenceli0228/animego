-- Queries against anime_cache and its child tables.
--
-- Each :one / :many / :exec annotation tells sqlc which result shape to
-- generate.  Parameters use $1, $2, ... in declaration order; sqlc emits
-- a Params struct once parameter count exceeds the query_parameter_limit
-- set in sqlc.yaml (5).
--
-- See go-api/README.md "Adding a new endpoint" for the handler-side
-- pattern that calls these.

-- name: GetCompletedGems :many
-- "Completed gems" is the /api/anime/completed-gems endpoint —
-- a random sample of finished, highly-rated anime with a cover image.
-- Replaces server/controllers/anime.controller.js:77-87.
--
-- average_score is on the AniList 0-100 scale (verified against prod:
-- min 19, max 91, avg 64.25).  The Express threshold of 75 corresponds
-- to "highly rated by AniList community" and is preserved verbatim.
SELECT
    anilist_id,
    title_romaji,
    title_english,
    title_native,
    title_chinese,
    cover_image_url,
    cover_image_color,
    poster_accent,
    average_score,
    bangumi_score,
    episodes,
    season,
    season_year,
    status,
    format,
    description
FROM anime_cache
WHERE
    status = 'FINISHED'
    AND average_score >= 75
    AND cover_image_url IS NOT NULL
ORDER BY random()
LIMIT $1;

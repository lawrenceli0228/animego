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

-- name: GetYearlyTop :many
-- Top-rated TV/Movie/ONA anime for a single year.  Backs
-- /api/anime/yearly-top, replacing anime.controller.js:93-110.
-- Express limit is 20 hard, slice down to query limit in handler.
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
    season_year = $1
    AND average_score > 0
    AND format IN ('TV', 'MOVIE', 'ONA')
ORDER BY average_score DESC
LIMIT $2;

-- name: GetSeasonalAnime :many
-- Paginated season listing.  Backs /api/anime/seasonal (cache-first path)
-- and replaces the warmed-cache branch of anime.controller.js:113-127 +
-- the cached fallback in anilist.service.js getSeasonalAnime ②③.
-- Hentai filter is preserved verbatim — Express skipped via $nin.
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
    season = $1
    AND season_year = $2
    AND NOT EXISTS (
        SELECT 1 FROM anime_genres
        WHERE anime_genres.anime_id = anime_cache.anilist_id
          AND anime_genres.genre = 'Hentai'
    )
ORDER BY average_score DESC NULLS LAST
LIMIT $3 OFFSET $4;

-- name: CountSeasonal :one
-- Total non-Hentai entries for a given season + year.  Drives the
-- pagination meta in /api/anime/seasonal so the frontend can render
-- "X of Y" without a separate count call.
SELECT count(*)::bigint AS total
FROM anime_cache
WHERE
    season = $1
    AND season_year = $2
    AND NOT EXISTS (
        SELECT 1 FROM anime_genres
        WHERE anime_genres.anime_id = anime_cache.anilist_id
          AND anime_genres.genre = 'Hentai'
    );

-- name: GetTrendingWithCounts :many
-- Most-subscribed anime with their cached metadata, ordered by watcher
-- count desc.  Backs /api/anime/trending and replaces the
-- Subscription.aggregate + AnimeCache.find round-trip in
-- anime.controller.js:17-50.  Single SQL with JOIN — no need for the
-- Express two-query pattern.
--
-- watching-only is preserved (the Mongo agg counts everything; the
-- Postgres replacement scopes to status='watching' to match the
-- frontend's "X watchers" semantic).
SELECT
    a.anilist_id,
    a.title_romaji,
    a.title_english,
    a.title_native,
    a.title_chinese,
    a.cover_image_url,
    a.cover_image_color,
    a.poster_accent,
    a.average_score,
    a.bangumi_score,
    a.episodes,
    a.season,
    a.season_year,
    a.status,
    a.format,
    a.description,
    s.watcher_count
FROM anime_cache a
JOIN (
    SELECT anilist_id, count(*)::bigint AS watcher_count
    FROM subscriptions
    WHERE status = 'watching'
    GROUP BY anilist_id
    ORDER BY count(*) DESC
    LIMIT 20
) s ON s.anilist_id = a.anilist_id
ORDER BY s.watcher_count DESC
LIMIT $1;

-- name: GetWatchers :many
-- Public watcher list for one anime.  Backs /api/anime/:anilistId/watchers.
-- Replaces anime.controller.js:53-75 — single SQL with JOIN drops the
-- Express two-step (find + populate) pattern.
SELECT u.username
FROM subscriptions s
JOIN users u ON u.id = s.user_id
WHERE s.anilist_id = $1 AND s.status = 'watching'
LIMIT $2;

-- name: CountWatchers :one
-- Total active watchers for /api/anime/:anilistId/watchers (the `total`
-- meta field in the envelope).
SELECT count(*)::bigint AS total
FROM subscriptions
WHERE anilist_id = $1 AND status = 'watching';

-- name: UpsertAnimeCache :exec
-- Upsert anime_cache main row from AniList sync.  Bangumi columns
-- (title_chinese, bgm_id, bangumi_score, bangumi_votes, bangumi_version)
-- are intentionally NOT overwritten on conflict — the enrichment workers
-- own those, and an AniList re-fetch should NOT clobber them.  Same goes
-- for admin_flag (manual override) and created_at (immutable).
--
-- cached_at + updated_at always bump to now() on both insert and update
-- so the stale-detection logic in /:anilistId can rely on monotonic
-- ordering.
--
-- Child tables (anime_genres / anime_studios / relations / characters /
-- staff / recommendations) are NOT touched here — callers must update
-- them in a separate transaction if needed.  /search + /schedule never
-- mutate child tables; only /:anilistId detail-fetch does.
INSERT INTO anime_cache (
    anilist_id,
    title_romaji, title_english, title_native,
    cover_image_url, cover_image_color,
    poster_accent, poster_accent_rgb, poster_accent_contrast_on_black,
    banner_image_url,
    description,
    episodes, status, season, season_year,
    average_score, format,
    cached_at, updated_at
) VALUES (
    $1,
    $2, $3, $4,
    $5, $6,
    $7, $8, $9,
    $10,
    $11,
    $12, $13, $14, $15,
    $16, $17,
    now(), now()
)
ON CONFLICT (anilist_id) DO UPDATE SET
    title_romaji = EXCLUDED.title_romaji,
    title_english = EXCLUDED.title_english,
    title_native = EXCLUDED.title_native,
    cover_image_url = EXCLUDED.cover_image_url,
    cover_image_color = EXCLUDED.cover_image_color,
    poster_accent = EXCLUDED.poster_accent,
    poster_accent_rgb = EXCLUDED.poster_accent_rgb,
    poster_accent_contrast_on_black = EXCLUDED.poster_accent_contrast_on_black,
    banner_image_url = EXCLUDED.banner_image_url,
    description = EXCLUDED.description,
    episodes = EXCLUDED.episodes,
    status = EXCLUDED.status,
    season = EXCLUDED.season,
    season_year = EXCLUDED.season_year,
    average_score = EXCLUDED.average_score,
    format = EXCLUDED.format,
    cached_at = now(),
    updated_at = now();

-- name: GetAnimeByAnilistIDs :many
-- Bulk read for /search post-upsert re-read so enriched fields
-- (title_chinese, bangumi_*) flow into the response even when the upsert
-- only carried AniList-side data.  Returns the same 16-column shape as
-- /completed-gems / /yearly-top so handlers can reuse the response
-- struct treatment.
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
WHERE anilist_id = ANY($1::int[])
ORDER BY average_score DESC NULLS LAST;

-- name: GetTitleChineseByAnilistIDs :many
-- Lightweight enrichment lookup for /schedule — only the 3 fields the
-- schedule items need.  bangumi_version is included so the caller can
-- decide whether to enqueue v1 enrichment for unenriched entries.
SELECT anilist_id, title_chinese, bangumi_version
FROM anime_cache
WHERE anilist_id = ANY($1::int[]);

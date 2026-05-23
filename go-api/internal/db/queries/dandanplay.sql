-- Queries used by /api/dandanplay/* orchestration (P2.6).
--
-- One query — SearchAnimeCacheForDandanplay — replaces Express's
-- buildKeywordRegex + AnimeCache.find($or 4 titles).  We use ILIKE
-- with tokenised pattern building (handler tokenises the keyword,
-- joins with '%' wildcards, passes the single pattern via $1).  The
-- existing trgm GIN indexes on title_chinese / title_native /
-- title_romaji / title_english make this cheap.
--
-- The handler is responsible for keyword token extraction (same regex
-- as Express's `[\p{L}\p{N}]+` group) and pattern composition.  This
-- keeps the SQL stable across keyword shapes and avoids generating
-- dynamic SQL per request.

-- name: SearchAnimeCacheForDandanplay :many
-- Returns up to 10 anime_cache rows whose title columns ILIKE the
-- caller-built keyword pattern.  Field selection mirrors the projection
-- Express exposed via .lean() — every column the 3-phase /match path
-- + /search route needs.
SELECT
    anilist_id,
    title_romaji,
    title_english,
    title_native,
    title_chinese,
    cover_image_url,
    cover_image_color,
    poster_accent,
    episodes,
    status,
    season,
    season_year,
    format,
    average_score,
    bangumi_score,
    bangumi_votes,
    bgm_id,
    source,
    duration
FROM anime_cache
WHERE
    title_chinese ILIKE $1
    OR title_native ILIKE $1
    OR title_romaji ILIKE $1
    OR title_english ILIKE $1
LIMIT 10;

-- name: GetAnimeByBgmID :one
-- findSiteAnime last-resort lookup:  Bangumi search yields a bgmId, this
-- query resolves it to a local anime_cache row so the /match handler
-- can return a populated siteAnime envelope.  Same projection as
-- SearchAnimeCacheForDandanplay for consistent downstream mapping.
--
-- Returns pgx.ErrNoRows when no row matches — handler treats that as a
-- null siteAnime (Express returned `null` in the same branch).
SELECT
    anilist_id,
    title_romaji,
    title_english,
    title_native,
    title_chinese,
    cover_image_url,
    cover_image_color,
    poster_accent,
    episodes,
    status,
    season,
    season_year,
    format,
    average_score,
    bangumi_score,
    bangumi_votes,
    bgm_id,
    source,
    duration
FROM anime_cache
WHERE bgm_id = $1
LIMIT 1;

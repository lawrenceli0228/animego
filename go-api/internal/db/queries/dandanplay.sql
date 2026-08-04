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
--
-- ORDER BY anilist_id is for DETERMINISM ONLY, not relevance: without it
-- the LIMIT truncates an arbitrary heap-order slice, so which rows of a
-- multi-season franchise even reach the caller could drift with vacuum.
-- Relevance ranking happens in Go (rankCacheRows) because it needs the
-- season/part gate, which SQL can't express cheaply.
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
ORDER BY anilist_id
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

-- name: GetAnimeByAnilistIDForDandanplay :one
-- Exact siteAnime resolution for the Phase 1 hit path.  dandanplay's
-- /api/v2/bangumi/:animeId response carries the entry's AniList URL in
-- `onlineDatabases`, which the client parses into EpisodeData.AniListID.
-- anilist_id is anime_cache's PRIMARY KEY, so this is the strongest
-- lookup we have — it replaces a fuzzy title search that could not tell
-- season 2 from season 3 of the same franchise.  Same projection as
-- SearchAnimeCacheForDandanplay for consistent downstream mapping.
--
-- Returns pgx.ErrNoRows when the AniList entry isn't cached locally —
-- the handler then falls through to the bgm_id / fuzzy legs.
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
WHERE anilist_id = $1
LIMIT 1;

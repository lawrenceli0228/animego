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

-- name: GetAnimeForBangumiSearch :one
-- Phase 1 worker uses titleNative (primary) → titleRomaji (fallback) as
-- the keyword for Bangumi search.  Mirrors anilist.service.js V1
-- enqueue (fetchBangumiData first arg).
SELECT title_native, title_romaji
FROM anime_cache
WHERE anilist_id = $1;

-- name: UpdateBangumiV1 :exec
-- Phase 1 result write — set bgm_id + title_chinese (the latter only
-- when the Bangumi search produced an exact native match with a
-- non-empty name_cn).  bangumi_version=1 marks ready for Phase 2.
--
-- title_chinese is *string so callers can pass nil when no exact match
-- (keeps the column NULL).  bgm_id is also *int because Bangumi search
-- may legitimately return no hits at all → caller sets bangumi_version
-- via a separate path or leaves it 0.
UPDATE anime_cache
SET bgm_id         = $2,
    title_chinese  = $3,
    bangumi_version = 1,
    updated_at     = now()
WHERE anilist_id = $1;

-- name: UpdateBangumiV2 :exec
-- Phase 2 result: write bangumi_score + bangumi_votes from Bangumi
-- Subject API.  Also conditionally fills title_chinese if it's still
-- NULL (V1 only writes it on exact native match; V2 has another shot
-- via the Subject's name_cn).  bangumi_version = 2 on completion.
--
-- title_chinese semantics: COALESCE keeps any existing CN string
-- (V1 may have set it from an exact-match search hit).  Pass nil for
-- title_chinese to leave existing value untouched.
UPDATE anime_cache
SET bangumi_score  = $2,
    bangumi_votes  = $3,
    title_chinese  = COALESCE(title_chinese, $4),
    bangumi_version = 2,
    updated_at     = now()
WHERE anilist_id = $1;

-- name: UpdateBangumiV3 :exec
-- Phase 3 heal-CN: re-fetches Subject's name_cn for v2-completed
-- entries whose title_chinese is still NULL.  Tiny operation —
-- bumps bangumi_version=3 either way (success or null).
UPDATE anime_cache
SET title_chinese  = $2,
    bangumi_version = 3,
    updated_at     = now()
WHERE anilist_id = $1;

-- name: UpdateAnimeCharacterCN :exec
-- Phase 2 character enrichment: match by anime_id + name_en
-- (Bangumi character.name vs our anime_characters.name_en) and fill
-- name_cn + voice_actor_cn + voice_actor_image_url.  Rows that don't
-- match a Bangumi entry stay as AniList-only.
--
-- name_en match is a coarse heuristic (Bangumi sometimes has English
-- names slightly different from AniList's romaji).  Future: fuzzy
-- match via trigram if needed.  For P2.1.7 exact match is OK.
UPDATE anime_characters
SET name_cn               = $3,
    voice_actor_cn        = $4,
    voice_actor_image_url = $5
WHERE anime_id = $1 AND name_en = $2;

-- name: GetAnimeMainByID :one
-- Full main-row read for /:anilistId detail.  Returns every column
-- the response payload needs (vs the trimmed 16-column shape
-- /completed-gems / /yearly-top use).  Child arrays come from the
-- 6 GetAnime*ByID queries below; service layer assembles them into
-- one nested response.
SELECT
    anilist_id,
    title_romaji,
    title_english,
    title_native,
    title_chinese,
    cover_image_url,
    cover_image_color,
    poster_accent,
    poster_accent_rgb,
    poster_accent_contrast_on_black,
    banner_image_url,
    description,
    episodes,
    status,
    season,
    season_year,
    average_score,
    format,
    duration,
    source,
    start_date,
    bgm_id,
    bangumi_score,
    bangumi_votes,
    bangumi_version,
    cached_at
FROM anime_cache
WHERE anilist_id = $1;

-- name: GetAnimeGenresByID :many
SELECT genre FROM anime_genres WHERE anime_id = $1 ORDER BY genre;

-- name: GetAnimeStudiosByID :many
SELECT studio FROM anime_studios WHERE anime_id = $1 ORDER BY studio;

-- name: GetAnimeRelationsByID :many
SELECT
    anilist_id,
    relation_type,
    title,
    cover_image_url,
    cover_image_color,
    poster_accent,
    poster_accent_rgb,
    poster_accent_contrast_on_black,
    format
FROM anime_relations
WHERE anime_id = $1;

-- name: GetAnimeCharactersByID :many
-- Sorted by display_order so the response preserves the AniList role
-- ordering (MAIN → SUPPORTING → BACKGROUND).  Phase 4 worker writes
-- name_cn + voice_actor_image_url + voice_actor_cn; they'll be NULL
-- until enrichment runs.
SELECT
    name_en,
    name_ja,
    name_cn,
    image_url,
    role,
    voice_actor_en,
    voice_actor_ja,
    voice_actor_cn,
    voice_actor_image_url
FROM anime_characters
WHERE anime_id = $1
ORDER BY display_order;

-- name: GetAnimeStaffByID :many
SELECT name_en, name_ja, image_url, role
FROM anime_staff
WHERE anime_id = $1
ORDER BY display_order;

-- name: GetAnimeRecommendationsByID :many
SELECT
    anilist_id,
    title,
    cover_image_url,
    cover_image_color,
    poster_accent,
    poster_accent_rgb,
    poster_accent_contrast_on_black,
    average_score
FROM anime_recommendations
WHERE anime_id = $1;

-- name: GetRelationEnrichmentByIDs :many
-- /:anilistId detail enriches relations[].titleChinese + .coverImageUrl
-- from anime_cache when the relation row itself has stale values.
-- Mirrors server/controllers/detail.controller.js:14-28.
SELECT anilist_id, title_chinese, cover_image_url
FROM anime_cache
WHERE anilist_id = ANY($1::int[]);

-- name: ListUnenrichedAnilistIDs :many
-- Boot-time orphan scan: returns anilist_ids of rows where
-- bangumi_version=0 (never enriched).  Paginated via limit/offset so
-- the caller can batch-enqueue without loading the whole table into
-- memory.  Ordered by anilist_id ASC for deterministic batching.
SELECT anilist_id
FROM anime_cache
WHERE bangumi_version = 0
ORDER BY anilist_id
LIMIT $1 OFFSET $2;

-- -------------------------------------------------------------------------
-- Child-table upsert pairs for /:anilistId AniList re-fetch (P2.1.6).
--
-- The "delete then insert" pattern matches Express's
-- mongoose findOneAndUpdate({...$set:{arrays}}) semantics: each child
-- array is wholly replaced, never merged.  Callers MUST run each
-- Delete+Insert pair as one logical operation; P2.1.6 accepts non-
-- transactional execution because the only observable failure mode is
-- "next read sees partial children" and the next stale-detection sweep
-- re-fetches.
-- -------------------------------------------------------------------------

-- name: DeleteAnimeGenres :exec
DELETE FROM anime_genres WHERE anime_id = $1;

-- name: InsertAnimeGenre :exec
INSERT INTO anime_genres (anime_id, genre) VALUES ($1, $2) ON CONFLICT DO NOTHING;

-- name: DeleteAnimeStudios :exec
DELETE FROM anime_studios WHERE anime_id = $1;

-- name: InsertAnimeStudio :exec
INSERT INTO anime_studios (anime_id, studio) VALUES ($1, $2) ON CONFLICT DO NOTHING;

-- name: DeleteAnimeRelations :exec
DELETE FROM anime_relations WHERE anime_id = $1;

-- name: InsertAnimeRelation :exec
-- Relations have a uuid PK; the table's default gen_random_uuid()
-- assigns the id automatically.  Same anilist_id may appear twice for a
-- parent with two relationship facets (e.g. SEQUEL + ALTERNATIVE) so no
-- ON CONFLICT clause — the uuid PK keeps the rows separate.
INSERT INTO anime_relations (
    anime_id, anilist_id, relation_type, title,
    cover_image_url, cover_image_color,
    poster_accent, poster_accent_rgb, poster_accent_contrast_on_black,
    format
) VALUES (
    $1, $2, $3, $4,
    $5, $6,
    $7, $8, $9,
    $10
);

-- name: DeleteAnimeCharacters :exec
DELETE FROM anime_characters WHERE anime_id = $1;

-- name: InsertAnimeCharacter :exec
-- display_order is the slice index (0-based) so the relational re-read
-- preserves the AniList edge ordering Express got for free from
-- Mongoose's array indexing.
INSERT INTO anime_characters (
    anime_id, display_order,
    name_en, name_ja, name_cn,
    image_url, role,
    voice_actor_en, voice_actor_ja, voice_actor_image_url
) VALUES (
    $1, $2,
    $3, $4, $5,
    $6, $7,
    $8, $9, $10
);

-- name: DeleteAnimeStaff :exec
DELETE FROM anime_staff WHERE anime_id = $1;

-- name: InsertAnimeStaffMember :exec
INSERT INTO anime_staff (
    anime_id, display_order,
    name_en, name_ja, image_url, role
) VALUES (
    $1, $2,
    $3, $4, $5, $6
);

-- name: DeleteAnimeRecommendations :exec
DELETE FROM anime_recommendations WHERE anime_id = $1;

-- name: InsertAnimeRecommendation :exec
INSERT INTO anime_recommendations (
    anime_id, anilist_id, title,
    cover_image_url, cover_image_color,
    poster_accent, poster_accent_rgb, poster_accent_contrast_on_black,
    average_score
) VALUES (
    $1, $2, $3,
    $4, $5,
    $6, $7, $8,
    $9
);

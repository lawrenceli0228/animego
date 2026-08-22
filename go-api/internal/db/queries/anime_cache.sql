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
    title_hant,
    title_hant_source,
    title_hant_seo,
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
    title_hant,
    title_hant_source,
    title_hant_seo,
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
--
-- `genres` is aggregated per row because the /seasonal page filters on it
-- client-side.  The old Express endpoint surfaced genres from the Mongo
-- enrichment cache; when the Go cutover landed this column was not carried
-- over, so `SeasonalAnime.genres` arrived undefined and every genre chip
-- silently matched nothing (lib/types.ts called this exact failure out as a
-- risk of the cutover).  The subquery costs nothing extra in practice: the
-- Hentai exclusion below already forces the same anime_genres lookup.
SELECT
    anilist_id,
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
    ARRAY(
        SELECT g.genre
        FROM anime_genres g
        WHERE g.anime_id = anime_cache.anilist_id
        ORDER BY g.genre
    )::text[] AS genres,
    (SELECT count(*)::bigint
     FROM episode_comments discussion
     WHERE discussion.anilist_id = anime_cache.anilist_id
    ) AS discussion_count
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
    a.title_hant,
    a.title_hant_source,
    a.title_hant_seo,
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
SELECT u.username, u.avatar_url, bc.cover_image_url AS backdrop_cover_url
FROM subscriptions s
JOIN users u ON u.id = s.user_id
LEFT JOIN anime_cache bc ON bc.anilist_id = u.backdrop_anilist_id
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
-- only carried AniList-side data.  Returns the same shape as
-- /completed-gems / /yearly-top so handlers can reuse the response
-- struct treatment.
--
-- title_hant / title_hant_source / title_hant_seo (migration 0022) ride
-- along on all three so a zh-Hant reader sees a Traditional card title.
-- title_hant_seo is the machine-conversion-free projection; SEO code
-- reads that one and no other.
SELECT
    anilist_id,
    title_romaji,
    title_english,
    title_native,
    title_chinese,
    title_hant,
    title_hant_source,
    title_hant_seo,
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
-- Lightweight enrichment lookup for /schedule — only the fields the
-- schedule items need.  bangumi_version is included so the caller can
-- decide whether to enqueue v1 enrichment for unenriched entries.
--
-- The hant trio (migration 0022) rides along because /schedule renders a
-- title, and it was the last displayed-title surface without a
-- Traditional one — every other list DTO already carries these three.
-- The name is now a slight lie; it is kept because the query is also the
-- warm-season worker's bangumi_version probe (queue/warm_season.go:259)
-- and renaming it would churn three test fakes for no behaviour change.
SELECT
    anilist_id,
    title_chinese,
    title_hant,
    title_hant_source,
    title_hant_seo,
    bangumi_version
FROM anime_cache
WHERE anilist_id = ANY($1::int[]);

-- name: ListAnimeForHantBackfill :many
-- Whole-table read for cmd/hantbackfill.  Every row, every run.
--
-- No WHERE clause and no candidate filter, which is a decision rather
-- than an omission: the tool's report has to account for all four tiers
-- plus the rows that reach none of them, and --restale has to recompute
-- a digest per row to know whether it is stale, so no predicate could
-- narrow the scan anyway.  That is the same reasoning that kept an index
-- out of migration 0022.
--
-- description_cn is here because it is the opencc tier's only input.  It
-- makes this the widest read in the file; it is also a one-shot CLI that
-- runs from an operator's shell, not a request path.
SELECT
    anilist_id,
    title_native,
    title_chinese,
    description_cn,
    title_hant,
    title_hant_source,
    title_hant_source_hash,
    description_hant,
    description_hant_source,
    description_hant_source_hash
FROM anime_cache
ORDER BY anilist_id;

-- name: ApplyHantTitleBatch :execrows
-- Bulk title_hant write for cmd/hantbackfill --apply, 500 rows a call.
--
-- Parallel arrays rather than one array of composites because sqlc maps
-- text[] cleanly and a composite type would need a migration.  The three
-- value arrays never carry NULL: a row only appears here when a tier
-- produced something, so the caller has a value, a source and a hash for
-- every id it passes.
--
-- CALLER CONTRACT: all four arrays must be the same length.  Postgres
-- evaluates several set-returning functions in one SELECT list in
-- lockstep and pads the shorter ones with NULL rather than raising, so a
-- caller that passes 4 ids and 3 hashes gets a silent NULL hash on the
-- last row instead of an error.  cmd/hantbackfill enforces the lengths
-- in Go before calling (see applyBatches); anything else that reaches
-- this query must do the same.
--
-- :execrows so the caller can report how many rows actually changed.
-- The manual guard below means that number can legitimately be lower
-- than the number of ids passed -- a row hand-promoted to 'manual'
-- between the report and the apply is skipped -- and reporting the
-- input count as though it were the write count would hide exactly that.
--
-- The manual guard is the load-bearing line.  cmd/hantbackfill already
-- refuses to propose anything for a manual row, but that check lives in
-- Go and a future caller of this query will not have read it.  Expressed
-- here, "manual is never overwritten" survives a bug in the tool.
UPDATE anime_cache AS a
SET title_hant             = v.title_hant,
    title_hant_source      = v.title_hant_source,
    title_hant_source_hash = v.title_hant_source_hash
FROM (
    SELECT
        unnest(sqlc.arg(anilist_ids)::int[])  AS anilist_id,
        unnest(sqlc.arg(titles)::text[])      AS title_hant,
        unnest(sqlc.arg(sources)::text[])     AS title_hant_source,
        unnest(sqlc.arg(hashes)::text[])      AS title_hant_source_hash
) AS v
WHERE a.anilist_id = v.anilist_id
  AND (a.title_hant_source IS NULL OR a.title_hant_source <> 'manual');

-- name: ApplyHantDescriptionBatch :execrows
-- description_hant equivalent of ApplyHantTitleBatch.  Separate statement
-- rather than six more columns on that one because the two fill
-- independently — a row can have a Traditional title from a dataset and
-- no Chinese synopsis to convert, or the reverse — and merging them would
-- force NULL elements into the arrays, which text[] cannot carry through
-- sqlc without an empty-string sentinel.
UPDATE anime_cache AS a
SET description_hant             = v.description_hant,
    description_hant_source      = v.description_hant_source,
    description_hant_source_hash = v.description_hant_source_hash
FROM (
    SELECT
        unnest(sqlc.arg(anilist_ids)::int[])   AS anilist_id,
        unnest(sqlc.arg(descriptions)::text[]) AS description_hant,
        unnest(sqlc.arg(sources)::text[])      AS description_hant_source,
        unnest(sqlc.arg(hashes)::text[])       AS description_hant_source_hash
) AS v
WHERE a.anilist_id = v.anilist_id
  AND (a.description_hant_source IS NULL OR a.description_hant_source <> 'manual');

-- name: GetTorrentQueryInputsByAnilistID :one
-- Resolves the inputs the magnet aggregator needs to search by AniList id
-- instead of a raw keyword.  Backs the /api/anime/torrents?anilistId=N path:
-- the handler turns the four titles into deduped search variants and uses
-- anidb_id (when present) to pull AnimeTosho's complete aid feed.
--
-- LEFT JOIN bgm_id_map so a row missing from the id map (or with a NULL
-- anidb_id) still returns its titles — anidb_id comes back NULL and the
-- handler degrades to keyword-only (no aid feed).  pgx.ErrNoRows means "no
-- such anime cached" → handler 404s.
SELECT
    a.title_romaji,
    a.title_native,
    a.title_english,
    a.title_chinese,
    m.anidb_id
FROM anime_cache a
LEFT JOIN bgm_id_map m ON m.anilist_id = a.anilist_id
WHERE a.anilist_id = $1;

-- name: GetAnimeForBangumiSearch :one
-- Phase 1 worker uses titleNative (primary) → titleRomaji (fallback) as
-- the keyword for Bangumi search.  Mirrors anilist.service.js V1
-- enqueue (fetchBangumiData first arg).  title_english / season_year /
-- episodes feed the match scorer (internal/bangumi.PickBest) so a
-- low-confidence candidate is rejected instead of blindly bound.
SELECT title_native, title_romaji, title_english, season_year, episodes
FROM anime_cache
WHERE anilist_id = $1;

-- name: MarkBangumiV1NotFound :exec
-- Phase-1 found no Bangumi match. Mirror Express's no-bgmId branch:
-- terminal version=2 with null title_chinese + bgm_id so the orphan
-- scan (version=0) and re-enrich stop re-processing this row. Guarded
-- on bangumi_version=0 so we never clobber a row another worker advanced.
UPDATE anime_cache
SET title_chinese = NULL, bgm_id = NULL, bangumi_version = 2
WHERE anilist_id = $1 AND bangumi_version = 0;

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
SET bgm_id           = $2,
    title_chinese    = $3,
    bgm_match_source = $4,
    bangumi_version  = 1,
    updated_at       = now()
WHERE anilist_id = $1;

-- name: LookupBgmIdMap :one
-- Authoritative AniList->Bangumi binding from the vendored id map
-- (bgm_id_map, seeded from data/anilist_bgm_map.json).  The V1 worker
-- consults this BEFORE any Bangumi search; a hit binds the subject with
-- source='id_map' and skips fuzzy matching entirely.  pgx.ErrNoRows means
-- "not in the map" → caller falls through to the search + scorer path.
SELECT bgm_id FROM bgm_id_map WHERE anilist_id = $1;

-- name: MarkBangumiNeedsReview :exec
-- Phase-1 scorer found candidates but none confident enough to bind.  We
-- REFUSE to guess: no bgm_id is written.  Park the row terminal
-- (bangumi_version=2) so the auto-pipeline stops re-processing it, flag it
-- for a human, and record why via bgm_match_source='fuzzy_low'.  Guarded on
-- bangumi_version=0 so we never clobber a row another worker advanced.
UPDATE anime_cache
SET bgm_id           = NULL,
    title_chinese    = NULL,
    bgm_match_source = 'fuzzy_low',
    admin_flag       = 'needs-review',
    bangumi_version  = 2,
    updated_at       = now()
WHERE anilist_id = $1 AND bangumi_version = 0;

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
-- Phase 2 character enrichment: match by anime_id + (name_en OR name_ja).
-- Bangumi character.name is typically Japanese (e.g. "天使ヶ原恵") while
-- AniList stores it under name_ja; some AniList entries have English/
-- romaji names that match Bangumi's English alias instead.  Try both
-- columns to maximise the per-character hit rate.
--
-- P2.1.7 used name_en only — Bangumi vs AniList romanisation diffs
-- yielded 0% match in live smoke (anilist_id=200 Tenshi: 9 chars / 0
-- matched).  Switching to (name_en OR name_ja) recovers the typical
-- case where Bangumi-name == AniList.name.native; fuzzy trigram match
-- can land later if exact-Japanese still misses too many.
UPDATE anime_characters
SET name_cn               = $3,
    voice_actor_cn        = $4,
    voice_actor_image_url = $5
WHERE anime_id = $1
  AND (name_en = $2 OR name_ja = $2);

-- name: GetAnimeMainByID :one
-- Full main-row read for /:anilistId detail.  Returns every column
-- the response payload needs (vs the trimmed listing shape
-- /completed-gems / /yearly-top use).  Child arrays come from the
-- 6 GetAnime*ByID queries below; service layer assembles them into
-- one nested response.
--
-- description_hant / description_hant_source (migration 0022) appear
-- here and nowhere else, exactly like description_cn above them: a full
-- synopsis per card would roughly double the list payloads for text no
-- card renders.
--
-- episodes and episodes_bgm are two columns here for the same reason they
-- are two columns in GetEpisodeCountsByAnilistIDs below: episodes is
-- AniList's authoritative total, episodes_bgm (migration 0023) is inferred
-- from an external episode source, and nothing may coalesce them on the way
-- out of the database.  This projection feeds the detail page, which is the
-- consumer that emits numberOfEpisodes into schema.org JSON-LD -- so a
-- COALESCE here is the exact mechanism by which a guess would become a
-- factual claim to a search engine about the work.  The page picks; the
-- database does not pick for it.
SELECT
    anilist_id,
    title_romaji,
    title_english,
    title_native,
    title_chinese,
    title_hant,
    title_hant_source,
    title_hant_seo,
    cover_image_url,
    cover_image_color,
    poster_accent,
    poster_accent_rgb,
    poster_accent_contrast_on_black,
    banner_image_url,
    description,
    description_cn,
    description_cn_source,
    description_hant,
    description_hant_source,
    episodes,
    episodes_bgm,
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
--
-- The hant trio rides along for the same reason title_chinese does: a
-- relation card renders a title, and on /zh-Hant it should render the
-- Traditional one.
SELECT
    anilist_id,
    title_chinese,
    title_hant,
    title_hant_source,
    title_hant_seo,
    cover_image_url
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

-- name: GetAnimeEpisodeTitlesByID :many
-- Backs AnimeDetail.episodeTitles in /:anilistId.  Matches Express's
-- episodeTitles array shape: {episode, name, nameCn}.  Ordered by
-- episode ASC so the response is stable across re-fetches.
SELECT episode, name, name_cn
FROM anime_episode_titles
WHERE anime_id = $1
ORDER BY episode;

-- name: UpsertEpisodeTitle :exec
-- Written by the Bangumi V2 worker (the Phase-4 enrichment analog) after
-- fetching /subject/{bgmId}/ep.  Express set the whole episodeTitles array;
-- we upsert per episode so a re-enrich refreshes names in place. ON CONFLICT
-- overwrites so corrected Bangumi data wins on the next pass.
INSERT INTO anime_episode_titles (anime_id, episode, name_cn, name)
VALUES ($1, $2, $3, $4)
ON CONFLICT (anime_id, episode) DO UPDATE
  SET name_cn = EXCLUDED.name_cn,
      name    = EXCLUDED.name;

-- name: UpdateDescriptionCn :exec
-- Store a Chinese description harvested from Bangumi's Subject.Summary.
--
-- The trust gate lives in this WHERE clause rather than in Go so the check
-- and the write are one statement: a row whose bgm_id is a fuzzy guess can
-- never have a summary written against it, with no window between deciding
-- and writing.
--
-- Why the gate is not simply `bgm_match_source = 'id_map'`: that column
-- records how a binding was *made*, and rows bound before 0011 landed carry
-- NULL even when they are correct. What actually matters is whether an
-- independent authority agrees with the binding we hold, so the gate asks
-- exactly that — does bgm_id_map (refreshed weekly from the vendored
-- AniList->Bangumi map) list this same pair? A 2026-06 audit found the 7,183
-- rows with an authoritative answer agreed 100%, while the known mis-bindings
-- all sit in the no-map tail, which this excludes.
--
-- Stakes: a wrong title is a wrong word, a wrong summary is a whole page
-- describing the wrong show — and it would land in the meta description and
-- JSON-LD too.
--
-- 'manual' is never overwritten: it is the admin override, and an automated
-- sweep must not undo a human correction.
UPDATE anime_cache ac
SET description_cn        = sqlc.arg(description_cn),
    description_cn_source = 'bangumi',
    updated_at            = now()
WHERE ac.anilist_id = sqlc.arg(anilist_id)
  -- Pin the write to the binding the job actually fetched. Without this the
  -- statement only says "this anime", so a rebind landing mid-job would file
  -- the old subject's synopsis against the new one. The window is small but
  -- the failure is a whole page describing a different show.
  AND ac.bgm_id = sqlc.arg(bgm_id)
  AND coalesce(ac.description_cn_source, '') <> 'manual'
  AND EXISTS (
      SELECT 1 FROM description_cn_eligible e
      WHERE e.anilist_id = ac.anilist_id
  );

-- name: ListDescriptionCnCandidates :many
-- Rows still missing a Chinese description that could actually receive one.
--
-- The trust gate is repeated here rather than left to UpdateDescriptionCn
-- alone. Both need it, but for different reasons: the writer needs it for
-- correctness, and this reader needs it so the sweep does not spend an
-- upstream Bangumi request on a row whose write is guaranteed to affect zero
-- rows. On the current catalogue that is ~3,200 rows — bindings we hold but
-- no independent source confirms — which would otherwise be fetched on every
-- pass forever, since nothing about them ever changes.
--
-- Ordering by attempt time, not by id, is what lets the sweep finish. A row
-- whose summary the language gate rejects stays description_cn IS NULL, so
-- under ORDER BY anilist_id it would hold its place at the front of every
-- batch and the sweep would converge to p·B/(1−p) lifetime writes — about 450
-- rows out of ~9,100. Attempt time puts a processed row behind everything not
-- yet tried, whether or not it produced text. See migration 0015.
--
-- The cooldown then doubles as a retry: Bangumi summaries are community
-- written over time, so a subject that is Japanese-only today may carry Chinese
-- prose next quarter, and re-reaching it is how that gets picked up.
-- The description_cn_source = 'llm' arm hands machine-translated rows back
-- to this sweep on its normal 30-day cadence: Bangumi summaries are written
-- by its community over time, and the covenant is manual > bangumi > llm —
-- a human-written synopsis appearing upstream must eventually replace the
-- machine translation.  UpdateDescriptionCn already permits that overwrite
-- (its guard only protects 'manual'); this arm is what gets the row fetched
-- again at all.  Mirror-kept in admin.sql's desc_cn_pending — change one,
-- change both.
SELECT ac.anilist_id, ac.bgm_id
FROM description_cn_eligible ac
WHERE (ac.description_cn IS NULL OR ac.description_cn_source = 'llm')
  AND (
      ac.description_cn_attempted_at IS NULL
      OR ac.description_cn_attempted_at < now() - sqlc.arg(retry_after)::interval
  )
ORDER BY ac.description_cn_attempted_at NULLS FIRST, ac.anilist_id
LIMIT sqlc.arg(row_limit);

-- name: ListDescriptionCnLlmCandidates :many
-- Rows for the LLM translation fallback: an English source text exists, no
-- Chinese landed yet, and the Bangumi channel is done with the row — either
-- it already tried (attempt stamp set; the subject had no usable Chinese) or
-- the row can never enter that channel at all (binding fails the
-- description_cn_eligible trust gate, or there is no bgm_id).  The LLM tier
-- is strictly Bangumi's leftovers; it never races the primary channel.
--
-- Ordering by the LLM attempt stamp gives this sweep the same finish
-- guarantee as the Bangumi one (migration 0015 arithmetic): a row whose
-- translation failed validation goes to the back instead of holding the
-- front of every batch.
SELECT ac.anilist_id
FROM anime_cache ac
WHERE ac.description IS NOT NULL AND ac.description <> ''
  AND ac.description_cn IS NULL
  AND (
      ac.description_cn_llm_attempted_at IS NULL
      OR ac.description_cn_llm_attempted_at < now() - sqlc.arg(retry_after)::interval
  )
  AND (
      ac.description_cn_attempted_at IS NOT NULL
      OR NOT EXISTS (
          SELECT 1 FROM description_cn_eligible e
          WHERE e.anilist_id = ac.anilist_id
      )
  )
ORDER BY ac.description_cn_llm_attempted_at NULLS FIRST, ac.anilist_id
LIMIT sqlc.arg(row_limit);

-- name: GetDescriptionForLlmTranslate :one
-- The per-row worker's re-read.  Job args deliberately carry only the
-- anilist_id (payload dedupe stays cheap, river rows stay small), so the
-- worker fetches the source text at work time — and re-checks description_cn,
-- because the Bangumi channel may have landed a real summary between scan and
-- work.  In that race the LLM worker must stand down, not spend tokens.
SELECT ac.description, ac.description_cn
FROM anime_cache ac
WHERE ac.anilist_id = $1;

-- name: UpdateDescriptionCnLlm :exec
-- Store a machine translation.  The guard is description_cn IS NULL — the
-- LLM tier writes into empty space only and can never overwrite bangumi,
-- manual, or even an earlier llm value.  The reverse covenant (bangumi
-- replacing llm) lives in ListDescriptionCnCandidates + UpdateDescriptionCn.
UPDATE anime_cache
SET description_cn        = sqlc.arg(description_cn),
    description_cn_source = 'llm',
    updated_at            = now()
WHERE anilist_id = sqlc.arg(anilist_id)
  AND description_cn IS NULL;

-- name: MarkDescriptionCnLlmAttempted :exec
-- Stamp a row as tried by the LLM sweep, regardless of outcome — stored,
-- rejected by validation, or skipped because bangumi won the race.  NOT
-- called on transport errors, which river should retry rather than have the
-- sweep treat as decided.  Counterpart to the ordering in
-- ListDescriptionCnLlmCandidates, exactly as migration 0015 is to the
-- Bangumi sweep.
UPDATE anime_cache
SET description_cn_llm_attempted_at = now()
WHERE anilist_id = $1;

-- name: MarkDescriptionCnAttempted :exec
-- Stamp a row as tried, regardless of whether it yielded usable Chinese.
--
-- Called for every outcome the upstream actually answered — text stored,
-- summary rejected by the language gate, subject absent from Bangumi — but NOT
-- for network failures, which river should retry rather than have the sweep
-- treat as a decided outcome.
--
-- This is the counterpart to the ordering in ListDescriptionCnCandidates: the
-- stamp is what moves a row to the back of the queue and lets the sweep reach
-- the rest of the backlog.
UPDATE anime_cache
SET description_cn_attempted_at = now()
WHERE anilist_id = $1;

-- name: GetAnimeEpisodeCount :one
-- Authoritative total-episode count for one title, used by
-- PATCH /api/subscriptions/:anilistId as the upper bound on currentEpisode.
--
-- Deliberately a standalone read rather than a guard folded into
-- UpdateSubscriptionWithActivity's CTE: inside the CTE an out-of-range
-- episode degrades to "0 rows updated", which is indistinguishable from
-- "no such subscription" — one pgx.ErrNoRows for two conditions the API
-- has to answer differently (400 vs 404).
--
-- NULL episodes means "airing / unknown length"; the caller must treat that
-- as "no bound" and let the write through rather than rejecting it.
-- pgx.ErrNoRows means the title isn't cached at all, in which case the FK on
-- subscriptions guarantees there is no subscription to update either.
SELECT episodes
FROM anime_cache
WHERE anilist_id = $1;

-- name: GetEpisodeCountsByAnilistIDs :many
-- Batch episode-count read for GET /api/anime/episodes, which the
-- browser-side library calls once to backfill a per-series total for
-- series it has ALREADY bound.  The binding path short-circuits on an
-- existing binding and returns no episode data, so without a batch read
-- there is no route by which an already-bound series ever learns its
-- length.
--
-- Three columns and no more: this is a hot, wide-fan-in read (up to 200
-- ids per call) whose only job is to answer "how many episodes".  The
-- title trio that rides along on the other ANY($1::int[]) reads in this
-- file is deliberately absent — the caller already has the titles.
--
-- episodes and episodes_bgm are returned as two separate columns and are
-- NOT coalesced here, or anywhere downstream.  episodes is AniList's
-- authoritative value; episodes_bgm (migration 0023) is inferred from an
-- external source.  A downstream consumer emits numberOfEpisodes into
-- schema.org JSON-LD and only the authoritative value may appear there, so
-- a COALESCE in this query would launder an inferred count into structured
-- data.  Callers pick; the database does not pick for them.
--
-- Ids with no anime_cache row simply do not come back.  The handler
-- returns the short list rather than padding it with nulls — an absent id
-- and an id whose counts are both NULL are different facts and the caller
-- can already tell them apart.
SELECT
    anilist_id,
    episodes,
    episodes_bgm
FROM anime_cache
WHERE anilist_id = ANY($1::int[]);

-- name: ListEpisodesBgmCandidates :many
-- Rows whose episode count is unknown to AniList and whose Bangumi binding
-- might be able to supply one.
--
-- `episodes IS NULL` is the anchor, and it is the only conjunct migration
-- 0023's partial index carries.  It is also the one condition this sweep can
-- never satisfy on its own: the worker writes episodes_bgm and NEVER
-- anime_cache.episodes, so a row leaves the candidate set only when an
-- AniList sync finally learns a real total.
--
-- THE COOLDOWN ARMS ARE THE POINT.  The predicate originally specified for
-- this sweep --
--
--   episodes IS NULL
--   AND (episodes_bgm IS NULL
--        OR (status = 'RELEASING' AND episodes_bgm_at < now() - interval '20 hours'))
--
-- -- never terminates.  A row the identity gate rejects, and a row whose
-- upstream returns no episodes, both produce no count, so `episodes_bgm IS
-- NULL` stays true and they hold the front of every later batch forever.
-- Migration 0015 documents that exact stall already happening once on this
-- table, and 0023 added episodes_bgm_attempted_at / _outcome to stop the
-- repeat.  So candidacy is decided by the ATTEMPT stamp plus the recorded
-- outcome, and the ordering is 0015's.
--
-- Every value the 0023 CHECK admits has an arm below.  A value with no arm
-- matches nothing and freezes that row permanently -- which is the failure
-- these columns exist to prevent -- so 'error' gets an arm even though
-- nothing writes it today (transport failures are deliberately left
-- unstamped for river to retry; see MarkEpisodesBgmAttempted).
--
-- Rows at 'ok' or 'empty' whose status is not RELEASING match no arm at all,
-- and that is deliberate rather than an omission: a finished show's episode
-- count is settled, and re-asking upstream forever would spend the shared
-- Bangumi budget to re-learn the same number.
--
-- anilist_ids is an OPTIONAL narrowing.  An EMPTY array means "the whole
-- catalogue" (the hourly sweep); a non-empty one restricts to those ids (the
-- warm-season seed).  One query rather than two so the seed can never enqueue
-- work the sweep itself would not take, and so the two can never drift apart.
SELECT
    ac.anilist_id,
    ac.bgm_id
FROM anime_cache ac
WHERE ac.episodes IS NULL
  AND ac.bgm_id IS NOT NULL
  AND (
      cardinality(sqlc.arg(anilist_ids)::int[]) = 0
      OR ac.anilist_id = ANY(sqlc.arg(anilist_ids)::int[])
  )
  AND (
      -- Never tried.
      ac.episodes_bgm_attempted_at IS NULL
      -- Still airing and upstream last gave a real answer: whatever was
      -- derived is provisional by construction, so re-ask about once a day.
      OR (ac.status = 'RELEASING'
          AND ac.episodes_bgm_outcome IN ('ok', 'empty')
          AND ac.episodes_bgm_attempted_at < now() - sqlc.arg(airing_recheck)::interval)
      -- The gate could not tell.  Only better data changes that, and the
      -- data in question (the id map, an admin correction) moves on its own
      -- schedule.
      OR (ac.episodes_bgm_outcome = 'undecided'
          AND ac.episodes_bgm_attempted_at < now() - sqlc.arg(undecided_retry)::interval)
      -- The gate refused the binding.  Only a RE-BINDING changes that, and
      -- every re-binding path clears these columns outright (admin.sql
      -- ResetAnimeEnrichment / FlagAnimeEnrichment /
      -- UpdateAnimeEnrichmentSelective), which puts the row back at
      -- attempted_at IS NULL and at the front of the queue.  So this arm is
      -- the slow backstop, not the repair mechanism.
      OR (ac.episodes_bgm_outcome = 'rejected'
          AND ac.episodes_bgm_attempted_at < now() - sqlc.arg(rejected_retry)::interval)
      -- Safety arm; see the note above about covering every CHECK value.
      OR (ac.episodes_bgm_outcome = 'error'
          AND ac.episodes_bgm_attempted_at < now() - sqlc.arg(error_retry)::interval)
  )
ORDER BY ac.episodes_bgm_attempted_at NULLS FIRST, ac.anilist_id
LIMIT sqlc.arg(row_limit);

-- name: GetEpisodesBgmGateInputs :one
-- The identity gate's inputs, re-read at work time.
--
-- bgm_id comes back so the worker can compare it against the id its job
-- payload carries.  That comparison is not paranoia: the payload was written
-- when the scan ran, an admin PATCH or reset can land in between, and a job
-- that trusted its own arguments would fetch one subject and file the result
-- against a different binding.
--
-- title_native and title_romaji are the AniList-side titles, and they are the
-- ONLY titles a similarity comparison may use.  title_chinese is deliberately
-- absent from this projection: on a mis-bound row it has already been
-- overwritten with the wrong show's Chinese name by earlier enrichment, so
-- comparing it against the same subject's name_cn passes every time -- it
-- validates the error with the error.  Leaving the column out of the query is
-- a cheaper guarantee than a comment asking a future reader not to use it.
--
-- id_map_agrees asks whether the vendored AniList->Bangumi map lists THIS
-- pair, not merely whether it has a row for this anilist_id.  A map entry
-- naming a different bgm_id is evidence against the binding, so it must not
-- read as authoritative confirmation of it.  Same test as the
-- description_cn_eligible view (migration 0016).
SELECT
    ac.bgm_id,
    ac.bgm_match_source,
    ac.title_native,
    ac.title_romaji,
    EXISTS (
        SELECT 1 FROM bgm_id_map m
        WHERE m.anilist_id = ac.anilist_id
          AND m.bgm_id = ac.bgm_id
    ) AS id_map_agrees
FROM anime_cache ac
WHERE ac.anilist_id = sqlc.arg(anilist_id);

-- name: UpdateEpisodesBgm :execrows
-- Store an inferred episode count, and stamp the attempt in the same
-- statement so the two can never disagree.
--
-- The bgm_id in the WHERE clause pins the write to the binding the job
-- actually fetched -- the same move UpdateDescriptionCn makes, for the same
-- reason.  The Go-side re-read closes most of the rebind window; this closes
-- the rest, and turns the race into an observable zero-row result instead of
-- a wrong number.
--
-- episodes (AniList's authoritative count) is NEVER written here.  An AniList
-- sync UPSERT sets `episodes = EXCLUDED.episodes`, so a value written there
-- would be cleared on the next warm anyway -- and, more to the point, a
-- downstream consumer emits `episodes` into schema.org JSON-LD, where an
-- inferred number must never appear.
UPDATE anime_cache
SET episodes_bgm              = sqlc.arg(episodes_bgm),
    episodes_bgm_at           = now(),
    episodes_bgm_attempted_at = now(),
    episodes_bgm_outcome      = 'ok',
    episodes_bgm_reason       = NULL,
    updated_at                = now()
WHERE anilist_id = sqlc.arg(anilist_id)
  AND bgm_id     = sqlc.arg(bgm_id);

-- name: MarkEpisodesBgmAttempted :execrows
-- Record a decided NON-'ok' outcome so the sweep can move past this row.
--
-- Called for every outcome upstream actually answered -- the gate refused the
-- binding, the gate could not tell, the episode list came back empty -- but
-- NOT for transport failures, which river should retry rather than have the
-- sweep treat as decided.  Counterpart to the ordering in
-- ListEpisodesBgmCandidates, exactly as MarkDescriptionCnAttempted is to the
-- Chinese-description sweep.
--
-- 'rejected' additionally clears any count already on the row, because that
-- outcome is a positive statement that the value's provenance is repudiated.
-- 'undecided', 'empty' and 'error' leave it alone: they are absence of
-- evidence, not evidence of a wrong binding, and nulling a good count on a
-- transiently empty upstream response would be a regression the next pass
-- could not distinguish from never having had one.
--
-- updated_at is deliberately NOT bumped -- this is bookkeeping, not a data
-- change, and MarkDescriptionCnAttempted takes the same stance.  It matters
-- here because an airing row can be stamped every day for months.
UPDATE anime_cache
SET episodes_bgm              = CASE WHEN sqlc.arg(outcome)::text = 'rejected'
                                     THEN NULL ELSE episodes_bgm END,
    episodes_bgm_at           = CASE WHEN sqlc.arg(outcome)::text = 'rejected'
                                     THEN NULL ELSE episodes_bgm_at END,
    episodes_bgm_attempted_at = now(),
    episodes_bgm_outcome      = sqlc.arg(outcome)::text,
    episodes_bgm_reason       = sqlc.narg(reason)
WHERE anilist_id = sqlc.arg(anilist_id)
  AND bgm_id     = sqlc.arg(bgm_id);

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
    description_cn,
    description_cn_source,
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

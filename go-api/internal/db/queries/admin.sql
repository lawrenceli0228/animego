-- Queries for /api/admin/* (P2.3).
--
-- Most admin reads are single-row aggregates or list-by-version batches.
-- ListEnrichment + ListAdminUsers are intentionally NOT here because they
-- need dynamic ORDER BY + filter composition that sqlc cannot express
-- without an explosion of query variants — those run as raw pgxpool
-- queries in internal/admin/list.go with a column-name allow-list.
--
-- Conventions:
--   * count() cast to ::bigint so sqlc generates int64 (matching Express's
--     JS Number which is int64-safe up to 2^53).
--   * Selective UPDATE uses COALESCE($1, column) only when the field is
--     *string and "nil means skip" semantics apply.  Setting a field to
--     NULL on purpose uses a pgtype.Text wrapper in the handler.
--   * RETURNING the projection columns matches Express's .select() shape.

-- name: GetAdminStats :one
-- /api/admin/stats — COUNT()s in a single round-trip.
-- Replaces Promise.all() of 10 Mongo countDocuments calls.  All counts
-- run as correlated subqueries so we get one row, one fetch.
SELECT
    (SELECT count(*) FROM users)::bigint                                                              AS total_users,
    (SELECT count(*) FROM anime_cache)::bigint                                                        AS total_anime,
    (SELECT count(*) FROM anime_cache WHERE bangumi_version = 0)::bigint                              AS enrich_v0,
    (SELECT count(*) FROM anime_cache WHERE bangumi_version = 1)::bigint                              AS enrich_v1,
    (SELECT count(*) FROM anime_cache WHERE bangumi_version = 2)::bigint                              AS enrich_v2,
    (SELECT count(*) FROM anime_cache WHERE bangumi_version >= 3)::bigint                             AS enrich_v3,
    (SELECT count(*) FROM anime_cache WHERE bgm_id IS NOT NULL AND title_chinese IS NULL)::bigint     AS no_cn,
    -- Honesty fields (P3/P4): real CN coverage + the "Heal CN can actually
    -- fix" count + the unhealable v3-no-cn + the by-source breakdown.
    (SELECT count(*) FROM anime_cache WHERE title_chinese IS NOT NULL)::bigint                        AS has_cn,
    (SELECT count(*) FROM anime_cache WHERE bgm_id IS NOT NULL AND bangumi_version = 2 AND title_chinese IS NULL)::bigint AS heal_cn_real,
    (SELECT count(*) FROM anime_cache WHERE bangumi_version >= 3 AND bgm_id IS NOT NULL AND title_chinese IS NULL)::bigint AS cn_stuck,
    (SELECT count(*) FROM anime_cache WHERE bgm_match_source = 'id_map')::bigint                      AS src_id_map,
    (SELECT count(*) FROM anime_cache WHERE bgm_match_source = 'fuzzy_high')::bigint                  AS src_fuzzy_high,
    (SELECT count(*) FROM anime_cache WHERE bgm_match_source = 'fuzzy_low')::bigint                   AS src_fuzzy_low,
    (SELECT count(*) FROM anime_cache WHERE admin_flag IS NOT NULL)::bigint                           AS flagged,
    (SELECT count(*) FROM subscriptions)::bigint                                                      AS total_subs,
    (SELECT count(*) FROM follows)::bigint                                                            AS total_follows;

-- name: GetAnimeCacheRowForReset :one
-- Read the row Reset will mutate.  Returns the projection columns the
-- handler needs to re-enqueue: anilist_id, title_native, title_romaji.
-- Errors out cleanly with pgx.ErrNoRows when the anime doesn't exist
-- (handler maps → 404).
SELECT
    anilist_id,
    title_native,
    title_romaji,
    bgm_id
FROM anime_cache
WHERE anilist_id = $1;

-- name: ResetAnimeEnrichment :exec
-- POST /api/admin/enrichment/:anilistId/reset — Express:
--   doc.bangumiVersion = 0
--   doc.titleChinese   = null
--   doc.bgmId          = null
--   doc.bangumiScore   = undefined
--   doc.bangumiVotes   = undefined
--   doc.adminFlag      = null
--   await doc.save()
--
-- characters/episode_titles also wiped in Express (doc.episodeTitles +
-- doc.characters undefined).  In PG those are separate tables — handler
-- runs the corresponding DELETE inside the same transaction so the
-- re-enqueue produces a fresh enrichment cycle.
UPDATE anime_cache
SET
    bangumi_version = 0,
    title_chinese   = NULL,
    bgm_id          = NULL,
    bangumi_score   = NULL,
    bangumi_votes   = NULL,
    admin_flag      = NULL,
    bgm_match_source = NULL,
    updated_at      = now()
WHERE anilist_id = $1;

-- name: FlagAnimeEnrichment :one
-- POST /api/admin/enrichment/:anilistId/flag — set admin_flag to one of
-- 'needs-review' / 'manually-corrected' / NULL.  CHECK constraint on the
-- column enforces the allow-list at DB level; handler also pre-validates
-- so the 400 message is friendly.
UPDATE anime_cache
SET admin_flag = $2,
    updated_at = now()
WHERE anilist_id = $1
RETURNING
    anilist_id,
    title_romaji,
    title_chinese,
    bgm_id,
    bangumi_score,
    admin_flag;

-- name: UpdateAnimeEnrichmentSelective :one
-- PATCH /api/admin/enrichment/:anilistId — partial update.  COALESCE
-- pattern: pass NULL for fields the caller doesn't want to touch.  The
-- *string / *float64 / *int parameters serialize correctly via pgx; the
-- handler converts request body absent/present into nil/pointer.
--
-- admin_flag is always set to 'manually-corrected' as a side effect
-- (Express:  updates.adminFlag = 'manually-corrected').
UPDATE anime_cache
SET
    title_chinese = COALESCE(sqlc.narg('title_chinese'), title_chinese),
    bgm_id        = COALESCE(sqlc.narg('bgm_id')::integer, bgm_id),
    bangumi_score = COALESCE(sqlc.narg('bangumi_score')::numeric(4,2), bangumi_score),
    admin_flag    = 'manually-corrected',
    updated_at    = now()
WHERE anilist_id = sqlc.arg('anilist_id')::integer
RETURNING
    anilist_id,
    title_romaji,
    title_chinese,
    bgm_id,
    bangumi_score,
    admin_flag;

-- name: ListAnimeForReEnrichByVersion :many
-- Batch reader for re-enrich.  Returns the fields the queue payload
-- needs.  Filtering by version covers v0/v1/v2 — handler dispatches each
-- via the appropriate enqueue function.
--
-- For v0 the Express code accepts `bangumiVersion: 0` OR `$exists: false`.
-- In PG the column is `NOT NULL DEFAULT 0` (see 0001_init.up.sql:53) so
-- "missing" is impossible — a single = 0 covers it.
SELECT
    anilist_id,
    title_native,
    title_romaji,
    bgm_id,
    bangumi_version
FROM anime_cache
WHERE bangumi_version = $1;

-- name: ListEnrichedV2WithoutBgm :many
-- For re-enrich v=2:  rows that lack a bgm_id can't be V3-healed (V3
-- needs Bangumi subject id).  Express promotes them directly to v3 via
-- updateMany.  This query is the SELECT half; PromoteAnimeToV3 is the
-- UPDATE half.
SELECT anilist_id
FROM anime_cache
WHERE bangumi_version = 2
  AND bgm_id IS NULL;

-- name: ListEnrichedV2WithBgm :many
-- For re-enrich v=2:  rows that have a bgm_id can be V3-healed.
-- Returns the queue-payload fields directly.
SELECT
    anilist_id,
    bgm_id,
    title_chinese,
    bangumi_version
FROM anime_cache
WHERE bangumi_version = 2
  AND bgm_id IS NOT NULL;

-- name: PromoteAnimeToV3 :exec
-- Used by re-enrich v=2 path to mark no-bgm rows as fully enriched.
-- ANY($1::int[]) takes a Postgres int array — sqlc generates []int32.
UPDATE anime_cache
SET
    bangumi_version = 3,
    updated_at      = now()
WHERE anilist_id = ANY($1::integer[]);

-- name: ListHealCnCandidates :many
-- POST /api/admin/enrichment/heal-cn — Express filter:
--   bgmId: { $ne: null }
--   bangumiVersion: { $gte: 2, $lt: 3 }   // i.e. version = 2
--   $or: [{ titleChinese: null }, { titleChinese: { $exists: false } }]
--
-- Returns the queue payload shape (anilistId / bgmId / titleChinese /
-- bangumiVersion) so the handler can build V3 jobs directly.
SELECT
    anilist_id,
    bgm_id,
    title_chinese,
    bangumi_version
FROM anime_cache
WHERE bgm_id IS NOT NULL
  AND bangumi_version = 2
  AND title_chinese IS NULL;

-- name: DeleteAnimeCharactersForReset :exec
-- Wipe child tables when Reset clears a row.  Express puts characters /
-- episode_titles back to `undefined` in the document — Postgres mirrors
-- that with a DELETE inside the reset transaction.
DELETE FROM anime_characters WHERE anime_id = $1;

-- name: DeleteAnimeEpisodeTitlesForReset :exec
DELETE FROM anime_episode_titles WHERE anime_id = $1;

-- ==================== User management ====================

-- name: GetAdminUserSubFollowCounts :many
-- Batch fetch sub_count + follower_count for a slice of user ids.
-- Replaces the two Promise.all aggregate pipelines in listUsers.
-- Returns 0 for users with no rows on either side via LEFT JOIN.
SELECT
    u.id                                                                AS user_id,
    COALESCE(sub_counts.cnt, 0)::bigint                                  AS subscriptions,
    COALESCE(fol_counts.cnt, 0)::bigint                                  AS followers
FROM unnest($1::uuid[]) AS u(id)
LEFT JOIN (
    SELECT user_id, count(*) AS cnt
    FROM subscriptions
    GROUP BY user_id
) sub_counts ON sub_counts.user_id = u.id
LEFT JOIN (
    SELECT followee_id, count(*) AS cnt
    FROM follows
    GROUP BY followee_id
) fol_counts ON fol_counts.followee_id = u.id;

-- name: AdminCreateUser :one
-- POST /api/admin/users — create-by-admin path.  Caller bcrypts password
-- before passing it in.  RETURNING only the projection Express's
-- response uses ({ _id, username, email }) — handler maps to {id, ...}.
-- Unique violation (23505) bubbles up to handler → 409 with the field
-- name in the message.
INSERT INTO users (username, email, password)
VALUES ($1, $2, $3)
RETURNING id, username, email;

-- name: AdminUpdateUser :one
-- PATCH /api/admin/users/:userId — partial update of username/email.
-- COALESCE() lets the caller pass nil to skip a field; passing a value
-- overrides it.  Both empty means the handler returns 400 before we
-- reach this query.
UPDATE users
SET
    username   = COALESCE(sqlc.narg('username'), username),
    email      = COALESCE(sqlc.narg('email'), email),
    updated_at = now()
WHERE id = sqlc.arg('user_id')::uuid
RETURNING id, username, email, role, created_at;

-- name: AdminFindUserByUsernameOrEmailExcluding :one
-- Pre-update dup check.  Looks for an existing row with the same
-- username or email but a DIFFERENT id — i.e. would violate uniqueness
-- if the update went through.  Returns ErrNoRows when no conflict.
SELECT id, username, email
FROM users
WHERE (username = sqlc.narg('username') OR email = sqlc.narg('email'))
  AND id <> sqlc.arg('exclude_id')::uuid
LIMIT 1;

-- name: AdminFindUserByUsernameOrEmail :one
-- Pre-create dup check (no id exclusion since the row doesn't exist yet).
SELECT id, username, email
FROM users
WHERE username = sqlc.narg('username')
   OR email    = sqlc.narg('email')
LIMIT 1;

-- name: AdminDeleteUser :exec
-- DELETE /api/admin/users/:userId.  Subscriptions / follows / comments /
-- danmakus all ON DELETE CASCADE to users.id (see 0001_init.up.sql) so
-- a single DELETE removes everything Express did via Promise.all.
DELETE FROM users WHERE id = $1;

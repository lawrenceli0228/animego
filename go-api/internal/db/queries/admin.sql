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

-- name: GetDescriptionCnStats :one
-- Chinese-description backfill coverage (P3) — the four numbers behind the
-- /admin 中文简介回填 block.
--
-- WHY THIS IS A SEPARATE QUERY AND NOT FOUR MORE COLUMNS ON GetAdminStats:
-- every count below reads description_cn_eligible, a VIEW created by
-- migration 0016.  Folded into GetAdminStats, any problem with that view —
-- migration not yet applied on a rolled-forward container, a `migrate down`,
-- a statement timeout on the widest scan in the payload — takes the ENTIRE
-- stats response down with it, and the admin page loses users, anime,
-- enrichment, queue and flags along with the backfill block it was never
-- asked about.  Verified, not theorised:  dropping the view makes the fused
-- SELECT fail outright with `relation "description_cn_eligible" does not
-- exist`, because a missing relation is a planning error and no amount of
-- per-column care survives it.  Split out, the handler soft-fails this one
-- call (see read.go) and everything else still renders.  The least critical
-- panel on the page must not be able to blank the page.
--
-- All four read the view, never anime_cache directly.  That view is the
-- single definition of "this row's Bangumi binding is trustworthy enough to
-- copy a synopsis from", and the sweep's candidate query
-- (ListDescriptionCnCandidates) plus the writer's guard (UpdateDescriptionCn)
-- both read it too.  Re-deriving the predicate here would let the dashboard
-- drift away from what the sweep actually does — and a wrong number that
-- still looks authoritative is worse than no number.
--
-- The model is coverage, not batch progress:  the sweep is perpetual, so
-- there is no "total to process" that ever reaches 100%.  done/eligible is
-- the honest headline.
--
-- desc_cn_rejected and desc_cn_pending deliberately OVERLAP:  a row decided
-- against longer ago than the cooldown is both "we tried and got nothing" and
-- "the sweep will reach it again".  They answer different questions (how much
-- has upstream already refused us / how much work is live) and must not be
-- summed.  eligible = done + (rows with no CN), and that second term is what
-- rejected and pending each slice differently.
SELECT
    (SELECT count(*) FROM description_cn_eligible)::bigint                                            AS desc_cn_eligible,
    (SELECT count(*) FROM description_cn_eligible WHERE description_cn IS NOT NULL)::bigint           AS desc_cn_done,
    -- "Attempted and still empty".  NOT purely the language gate, despite
    -- being the metric an operator will read as such — DescriptionBackfillWorker
    -- stamps description_cn_attempted_at on every DECIDED outcome, and there
    -- are four of those:  Bangumi has no summary at all, the summary failed
    -- bangumi.CleanSummary's Chinese check, the subject 404'd (ErrNotFound —
    -- a stale binding), or the UPDATE itself errored and was swallowed.  Only
    -- transient fetch failures escape the stamp, because those return an error
    -- and go to river's retry path instead.
    --
    -- This matters for reading a spike:  a mass 404 or a broken writer produces
    -- NO retryable jobs (the worker returns nil in both cases), so the queue
    -- block stays green and this counter is the only place the breakage shows.
    -- Rejected climbing while done is flat is a signal to check the logs, not
    -- something to wave away as "Bangumi is Japanese-only".
    (SELECT count(*) FROM description_cn_eligible
      WHERE description_cn IS NULL
        AND description_cn_attempted_at IS NOT NULL)::bigint                                          AS desc_cn_rejected,
    -- The '30 days' literal MUST stay equal to descriptionBackfillRetryDays in
    -- internal/queue/description_backfill.go — that constant is what actually
    -- bounds ListDescriptionCnCandidates.  sqlc cannot read a Go const, so this
    -- is a hand-kept mirror:  if the two diverge, the dashboard's "pending"
    -- counts a different set of rows than the sweep will pick up, and the panel
    -- either shows work that never gets scheduled (literal too small) or hides
    -- work that is already queued (literal too large).  Change one, change both.
    --
    -- Note this is the whole live backlog, deliberately NOT capped at
    -- descriptionBackfillScanBatchSize:  the batch size throttles one pass, it
    -- does not define how much is outstanding.  Capping here would make the
    -- backlog look permanently 300-deep no matter how far behind it really is.
    (SELECT count(*) FROM description_cn_eligible
      WHERE description_cn IS NULL
        AND (
            description_cn_attempted_at IS NULL
            OR description_cn_attempted_at < now() - interval '30 days'
        ))::bigint                                                                                    AS desc_cn_pending;

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

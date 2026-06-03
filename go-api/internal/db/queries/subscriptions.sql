-- Queries against the subscriptions table (P2.4).
--
-- The subscriptions table has a (user_id, anilist_id) composite PK + FKs
-- to users(id) ON DELETE CASCADE and anime_cache(anilist_id) ON DELETE
-- CASCADE.  Five endpoints back this surface:
--
--   GET    /api/subscriptions               → ListUserSubscriptions
--   GET    /api/subscriptions/:anilistId    → GetSubscription
--   POST   /api/subscriptions               → UpsertSubscription
--   PATCH  /api/subscriptions/:anilistId    → UpdateSubscription
--   DELETE /api/subscriptions/:anilistId    → DeleteSubscription
--
-- Express joined Subscription + AnimeCache in application code; here we
-- do the join in SQL so the network round-trip is one query for the
-- list endpoint.  Single-row reads + writes don't need the join because
-- the upstream handler already has the anilist context.

-- name: ListUserSubscriptions :many
-- /api/subscriptions — list every subscription for one user, joined to
-- anime_cache for the listing-card columns the frontend needs.
-- Optional status filter:  when status is NULL the WHERE clause is a
-- tautology; passing a literal status filters to that bucket.
-- LEFT JOIN preserves rows even if anime_cache was cleared (unlikely
-- given ON DELETE CASCADE, but defensive).
SELECT
    s.user_id,
    s.anilist_id,
    s.status,
    s.current_episode,
    s.score,
    s.last_watched_at,
    s.created_at  AS subscribed_at,
    s.updated_at,
    a.title_romaji,
    a.title_english,
    a.title_native,
    a.title_chinese,
    a.cover_image_url,
    a.banner_image_url,
    a.cover_image_color,
    a.poster_accent,
    a.episodes,
    a.season,
    a.season_year,
    a.format,
    a.status        AS anime_status
FROM subscriptions s
LEFT JOIN anime_cache a ON a.anilist_id = s.anilist_id
WHERE s.user_id = $1
  AND (sqlc.narg('status_filter')::text IS NULL OR s.status = sqlc.narg('status_filter')::text)
ORDER BY s.updated_at DESC;

-- name: GetSubscription :one
-- /api/subscriptions/:anilistId — single subscription read.
-- pgx.ErrNoRows → 404 "Subscription not found".
SELECT
    user_id,
    anilist_id,
    status,
    current_episode,
    score,
    last_watched_at,
    created_at,
    updated_at
FROM subscriptions
WHERE user_id = $1
  AND anilist_id = $2;

-- name: UpsertSubscription :one
-- POST /api/subscriptions — create-or-update on (user_id, anilist_id).
-- Caller MUST have ensured anime_cache row exists (else the FK kicks).
-- ON CONFLICT only writes status — Express also only patches `status`
-- in the upsert payload, leaving current_episode/score untouched on
-- re-add.  RETURNING gives the canonical post-write state.
INSERT INTO subscriptions (user_id, anilist_id, status, updated_at)
VALUES ($1, $2, $3, now())
ON CONFLICT (user_id, anilist_id) DO UPDATE
SET status     = EXCLUDED.status,
    updated_at = now()
RETURNING
    user_id,
    anilist_id,
    status,
    current_episode,
    score,
    last_watched_at,
    created_at,
    updated_at;

-- name: UpdateSubscription :one
-- PATCH /api/subscriptions/:anilistId — selective update.
-- COALESCE pattern keeps unchanged columns untouched.  `last_watched_at`
-- only bumps when current_episode is explicitly set, matching Express
-- behaviour (only the current_episode mutation refreshes the watch
-- timestamp; status changes don't).  Score is clamped to [1,10] by the
-- application layer, not here — the DB constraint enforces it but
-- silently rejecting clamps would surprise the caller.
UPDATE subscriptions
SET
    status          = COALESCE(sqlc.narg('status'), status),
    current_episode = COALESCE(sqlc.narg('current_episode')::integer, current_episode),
    score           = CASE
                          WHEN sqlc.arg('score_set')::boolean THEN sqlc.narg('score')::integer
                          ELSE score
                      END,
    last_watched_at = CASE
                          WHEN sqlc.narg('current_episode')::integer IS NOT NULL THEN now()
                          ELSE last_watched_at
                      END,
    updated_at      = now()
WHERE user_id   = sqlc.arg('user_id')::uuid
  AND anilist_id = sqlc.arg('anilist_id')::integer
RETURNING
    user_id,
    anilist_id,
    status,
    current_episode,
    score,
    last_watched_at,
    created_at,
    updated_at;

-- name: DeleteSubscription :execrows
-- DELETE /api/subscriptions/:anilistId.  Returns the affected row count
-- so the handler can 404 when no row matched (matches Express's
-- findOneAndDelete returning null → 404 "Subscription not found").
DELETE FROM subscriptions
WHERE user_id = $1
  AND anilist_id = $2;

-- Queries against the subscriptions table (P2.4).
--
-- The subscriptions table has a (user_id, anilist_id) composite PK + FKs
-- to users(id) ON DELETE CASCADE and anime_cache(anilist_id) ON DELETE
-- CASCADE.  Five endpoints back this surface:
--
--   GET    /api/subscriptions               → ListUserSubscriptions
--   GET    /api/subscriptions/:anilistId    → GetSubscription
--   POST   /api/subscriptions               → UpsertSubscription
--                                             InsertSubscriptionIfAbsent
--                                             (when the body sets ifAbsent)
--   PATCH  /api/subscriptions/:anilistId    → UpdateSubscriptionWithActivity
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

-- name: InsertSubscriptionIfAbsent :one
-- POST /api/subscriptions with `"ifAbsent": true` — the click-to-track path.
--
-- UpsertSubscription above is wrong for this caller: its
-- ON CONFLICT DO UPDATE SET status resurrects a title the user deliberately
-- marked dropped/completed back into `watching` the moment anything touches
-- it.  §4 decision 3: creation is idempotent and `status` is human-only.
--
-- ON CONFLICT DO NOTHING returns zero rows on conflict, so the UNION ALL arm
-- reads the pre-existing row back and returns it untouched.  The NOT EXISTS
-- guard keeps the two arms mutually exclusive (same idiom as
-- InsertNotificationIfAbsent in community.sql and InsertReport in safety.sql).
--
-- Caller MUST have ensured the anime_cache row exists (else the FK kicks).
WITH inserted AS (
    INSERT INTO subscriptions (user_id, anilist_id, status, updated_at)
    VALUES (
        sqlc.arg('user_id')::uuid,
        sqlc.arg('anilist_id')::integer,
        sqlc.arg('status')::text,
        now()
    )
    ON CONFLICT (user_id, anilist_id) DO NOTHING
    RETURNING
        user_id,
        anilist_id,
        status,
        current_episode,
        score,
        last_watched_at,
        created_at,
        updated_at
)
SELECT
    user_id,
    anilist_id,
    status,
    current_episode,
    score,
    last_watched_at,
    created_at,
    updated_at
FROM inserted
UNION ALL
SELECT
    existing.user_id,
    existing.anilist_id,
    existing.status,
    existing.current_episode,
    existing.score,
    existing.last_watched_at,
    existing.created_at,
    existing.updated_at
FROM subscriptions existing
WHERE existing.user_id = sqlc.arg('user_id')::uuid
  AND existing.anilist_id = sqlc.arg('anilist_id')::integer
  AND NOT EXISTS (SELECT 1 FROM inserted)
LIMIT 1;

-- name: UpdateSubscriptionWithActivity :one
-- Lock the previous value, apply the selective update, and append a watch event
-- only when the caller supplied a genuinely different episode.  This prevents
-- retries/status-only patches from manufacturing duplicate feed entries.
--
-- `monotonic` picks the write semantics by call site:
--
--   monotonic = TRUE   player / library reconciliation.  current_episode can
--                      only move forward (GREATEST), so a stale tab replaying
--                      an old high-water mark can never claw progress back.
--                      Client-side comparison is not enough — its baseline is
--                      a cached copy (see §4 decision 8; Mihon #1793).
--   monotonic = FALSE  the detail page's ± buttons.  A human MUST be able to
--                      correct the count downward (§4 decision 4).
--
-- Both timestamps get a matching suppression under monotonic, for two
-- DIFFERENT reasons.  Keeping them straight matters, because only one of them
-- is load-bearing for anything a user can see today:
--
--   last_watched_at  Semantic honesty.  The column means "when an episode was
--                    actually watched", so a stale replay that GREATEST folds
--                    into a no-op must not touch it.  No consumer reads it for
--                    ordering right now — this is about the field not lying to
--                    whoever reads it next.  Mirrors the IS DISTINCT FROM guard
--                    inserted_activity already applies.
--
--   updated_at       This is the one the home page sees.  ListUserSubscriptions
--                    above is ORDER BY s.updated_at DESC, and ContinueWatching
--                    renders that order verbatim, so bumping updated_at on a
--                    no-op push would jump an untouched show to the front of
--                    the user's list.  ⚠️ If you ever change that ORDER BY,
--                    this CASE is why it was safe to suppress here.
--
-- updated_at's guard has to check two more fields than last_watched_at's: a
-- monotonic PATCH may legally also carry status or score (the reconciler never
-- sends those, but the endpoint accepts them), and those ARE real edits that
-- must bump the row.  Only a push that changes literally nothing is preserved.
--
-- Under monotonic = FALSE both rules stand exactly as they shipped — the
-- leading conjunct short-circuits, so the ± buttons see no change at all.
WITH previous AS (
    SELECT current_episode
    FROM subscriptions
    WHERE user_id = sqlc.arg('user_id')::uuid
      AND anilist_id = sqlc.arg('anilist_id')::integer
    FOR UPDATE
), updated AS (
    UPDATE subscriptions subscription
    SET
        status = COALESCE(sqlc.narg('status'), subscription.status),
        current_episode = CASE
                              WHEN sqlc.arg('monotonic')::boolean
                                  THEN GREATEST(
                                           subscription.current_episode,
                                           COALESCE(
                                               sqlc.narg('current_episode')::integer,
                                               subscription.current_episode
                                           )
                                       )
                              ELSE COALESCE(
                                       sqlc.narg('current_episode')::integer,
                                       subscription.current_episode
                                   )
                          END,
        score = CASE
                    WHEN sqlc.arg('score_set')::boolean
                        THEN sqlc.narg('score')::integer
                    ELSE subscription.score
                END,
        last_watched_at = CASE
                              WHEN sqlc.narg('current_episode')::integer IS NULL
                                  THEN subscription.last_watched_at
                              WHEN NOT sqlc.arg('monotonic')::boolean
                                  THEN now()
                              WHEN GREATEST(
                                       subscription.current_episode,
                                       sqlc.narg('current_episode')::integer
                                   ) IS DISTINCT FROM subscription.current_episode
                                  THEN now()
                              ELSE subscription.last_watched_at
                          END,
        updated_at = CASE
                         WHEN sqlc.arg('monotonic')::boolean
                              AND sqlc.narg('status') IS NULL
                              AND NOT sqlc.arg('score_set')::boolean
                              AND GREATEST(
                                      subscription.current_episode,
                                      COALESCE(
                                          sqlc.narg('current_episode')::integer,
                                          subscription.current_episode
                                      )
                                  ) IS NOT DISTINCT FROM subscription.current_episode
                             THEN subscription.updated_at
                         ELSE now()
                     END
    FROM previous
    WHERE subscription.user_id = sqlc.arg('user_id')::uuid
      AND subscription.anilist_id = sqlc.arg('anilist_id')::integer
    RETURNING subscription.*, previous.current_episode AS previous_episode
), inserted_activity AS (
    INSERT INTO activity_events (user_id, event_type, anilist_id, episode)
    SELECT
        user_id,
        'watch_progress',
        anilist_id,
        current_episode
    FROM updated
    WHERE sqlc.narg('current_episode')::integer IS NOT NULL
      AND current_episode IS DISTINCT FROM previous_episode
    RETURNING id
)
SELECT
    user_id,
    anilist_id,
    status,
    current_episode,
    score,
    last_watched_at,
    created_at,
    updated_at
FROM updated;

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

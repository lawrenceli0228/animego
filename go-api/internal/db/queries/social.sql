-- Queries for the social surface (P2.4) — follows + public profile + feed.
--
-- Backs five endpoints:
--   GET    /api/users/:username                    → GetPublicProfile (+ companion lists)
--   POST   /api/users/:username/follow             → UpsertFollow
--   DELETE /api/users/:username/follow             → DeleteFollow
--   GET    /api/users/:username/followers          → ListFollowers + CountFollowers
--   GET    /api/users/:username/following          → ListFollowing + CountFollowing
--   GET    /api/feed                                → ListFeedFolloweeIDs + ListFeedActivities
--
-- Express loaded these via Mongoose populate(); Postgres uses JOINs so
-- the round-trip count drops from 3-4 (find followee → populate → count)
-- down to one query per logical step.

-- name: GetUserIDByUsername :one
-- Helper: username → uuid lookup used by every social endpoint that
-- takes a username path param.  Returns id + canonical username
-- (handler echoes it back).  ErrNoRows → 404 "User not found".
SELECT id, username, created_at
FROM users
WHERE username = $1;

-- ==================== Follow CRUD ====================

-- name: UpsertFollow :exec
-- POST /api/users/:username/follow.  ON CONFLICT DO NOTHING — re-follow
-- is idempotent (Express used findOneAndUpdate with upsert; same effect).
-- The handler validates follower != followee before calling.
INSERT INTO follows (follower_id, followee_id)
VALUES ($1, $2)
ON CONFLICT (follower_id, followee_id) DO NOTHING;

-- name: DeleteFollow :execrows
-- DELETE /api/users/:username/follow.  Returns affected row count;
-- the handler always returns 200 { following: false } regardless of
-- whether a row was deleted (matches Express's findOneAndDelete which
-- returned 200 on either match-and-delete or no-match).
DELETE FROM follows
WHERE follower_id = $1
  AND followee_id = $2;

-- name: FollowExists :one
-- Is requester following the profile owner?  Used by the public
-- profile endpoint to compute isFollowing — null when caller is
-- anonymous (handler skips this query for anon callers).
SELECT EXISTS (
    SELECT 1 FROM follows
    WHERE follower_id = $1
      AND followee_id = $2
) AS is_following;

-- ==================== Followers / following lists ====================

-- name: ListFollowers :many
-- GET /api/users/:username/followers — paginated list of users who
-- follow the target user.  Returns the follower's username; Express
-- also only exposed username, not email or any other PII.
SELECT
    u.id,
    u.username,
    f.created_at AS followed_at
FROM follows f
JOIN users u ON u.id = f.follower_id
WHERE f.followee_id = $1
ORDER BY f.created_at DESC
LIMIT $2 OFFSET $3;

-- name: CountFollowers :one
-- Total follower count for the pagination envelope.
SELECT count(*) AS total
FROM follows
WHERE followee_id = $1;

-- name: ListFollowing :many
-- GET /api/users/:username/following — paginated list of users this
-- user is following.  Same shape as ListFollowers but reverse FK.
SELECT
    u.id,
    u.username,
    f.created_at AS followed_at
FROM follows f
JOIN users u ON u.id = f.followee_id
WHERE f.follower_id = $1
ORDER BY f.created_at DESC
LIMIT $2 OFFSET $3;

-- name: CountFollowing :one
SELECT count(*) AS total
FROM follows
WHERE follower_id = $1;

-- ==================== Public profile ====================

-- name: GetProfileCounts :one
-- Aggregate counts for the profile header.  Two correlated subqueries
-- so it's one round-trip.  followers = "how many follow this user",
-- following = "how many this user follows".  Named parameter binds
-- both subqueries to the same uuid value without sqlc complaining
-- about ambiguous column reference.
SELECT
    (SELECT count(*) FROM follows f WHERE f.followee_id = sqlc.arg('user_id')::uuid)::bigint AS follower_count,
    (SELECT count(*) FROM follows f WHERE f.follower_id = sqlc.arg('user_id')::uuid)::bigint AS following_count;

-- name: ListProfileWatching :many
-- The "watching" list shown on the public profile.  200-row cap matches
-- Express; the join is the same shape as the subscriptions list query
-- but only returns the cardview projection.
SELECT
    s.anilist_id,
    s.status,
    s.current_episode,
    s.last_watched_at,
    a.title_romaji,
    a.title_english,
    a.title_native,
    a.title_chinese,
    a.cover_image_url,
    a.cover_image_color,
    a.poster_accent,
    a.episodes,
    a.season,
    a.season_year,
    a.format,
    a.status AS anime_status
FROM subscriptions s
LEFT JOIN anime_cache a ON a.anilist_id = s.anilist_id
WHERE s.user_id = $1
ORDER BY s.updated_at DESC
LIMIT 200;

-- ==================== Feed ====================

-- name: ListFeedFolloweeIDs :many
-- Step 1 of /api/feed: load the followees the caller follows.
-- Hard cap 500 matches Express's MAX_FOLLOWEES_FOR_FEED.  Anything
-- beyond that and the feed degrades (older activities drop off the
-- bottom; rare in practice for a watch-list site).
SELECT followee_id
FROM follows
WHERE follower_id = $1
ORDER BY created_at DESC
LIMIT 500;

-- name: ListFeedActivities :many
-- Step 2 of /api/feed: most-recent watching activities of the supplied
-- followee_ids.  Filters out rows where last_watched_at IS NULL
-- (subscriptions that never had an episode marked).  JOINs users for
-- the username + anime_cache for the card columns.  Ordered by the
-- watch event time DESC so the feed reads chronologically.
SELECT
    s.anilist_id,
    s.status,
    s.current_episode,
    s.last_watched_at,
    u.username,
    a.title_romaji,
    a.title_chinese,
    a.cover_image_url
FROM subscriptions s
JOIN users u ON u.id = s.user_id
LEFT JOIN anime_cache a ON a.anilist_id = s.anilist_id
WHERE s.user_id = ANY($1::uuid[])
  AND s.last_watched_at IS NOT NULL
ORDER BY s.last_watched_at DESC
LIMIT $2 OFFSET $3;

-- name: CountFeedActivities :one
-- Total for pagination — same filter as ListFeedActivities sans paging.
SELECT count(*) AS total
FROM subscriptions
WHERE user_id = ANY($1::uuid[])
  AND last_watched_at IS NOT NULL;

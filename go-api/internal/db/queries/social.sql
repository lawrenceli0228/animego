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
SELECT id, username, created_at, avatar_url, backdrop_anilist_id, is_public
FROM users
WHERE username = $1;

-- ==================== Follow CRUD ====================

-- name: UpsertFollow :exec
-- POST /api/users/:username/follow.  ON CONFLICT DO NOTHING — re-follow
-- is idempotent (Express used findOneAndUpdate with upsert; same effect).
-- The handler validates follower != followee before calling.
INSERT INTO follows (follower_id, followee_id)
SELECT $1, $2
WHERE NOT EXISTS (
    SELECT 1
    FROM user_blocks block
    WHERE (block.blocker_id = $1 AND block.blocked_id = $2)
       OR (block.blocker_id = $2 AND block.blocked_id = $1)
)
ON CONFLICT (follower_id, followee_id) DO NOTHING;

-- name: UpsertFollowWithActivity :one
-- Only a newly-created relationship emits an activity and notification.
-- Re-follow after an unfollow refreshes the existing dedupe-key notification;
-- an idempotent retry never reaches either downstream CTE.
WITH inserted_follow AS (
    INSERT INTO follows (follower_id, followee_id)
    SELECT
        sqlc.arg('follower_id')::uuid,
        sqlc.arg('followee_id')::uuid
    WHERE NOT EXISTS (
        SELECT 1
        FROM user_blocks block
        WHERE (block.blocker_id = sqlc.arg('follower_id')::uuid
               AND block.blocked_id = sqlc.arg('followee_id')::uuid)
           OR (block.blocker_id = sqlc.arg('followee_id')::uuid
               AND block.blocked_id = sqlc.arg('follower_id')::uuid)
    )
    ON CONFLICT (follower_id, followee_id) DO NOTHING
    RETURNING follower_id, followee_id
), inserted_activity AS (
    INSERT INTO activity_events (user_id, event_type, target_user_id)
    SELECT follower_id, 'follow', followee_id
    FROM inserted_follow
    RETURNING id, user_id, target_user_id
), inserted_notification AS (
    INSERT INTO notifications (
        user_id,
        actor_id,
        notification_type,
        activity_event_id,
        dedupe_key
    )
    SELECT
        target_user_id,
        user_id,
        'follow',
        id,
        'follow:' || user_id::text
    FROM inserted_activity
    ON CONFLICT (user_id, dedupe_key) DO UPDATE
    SET actor_id = EXCLUDED.actor_id,
        activity_event_id = EXCLUDED.activity_event_id,
        read_at = NULL,
        created_at = now()
)
SELECT EXISTS (SELECT 1 FROM inserted_follow)::boolean AS inserted;

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
    u.avatar_url,
    bc.cover_image_url AS backdrop_cover_url,
    f.created_at AS followed_at
FROM follows f
JOIN users u ON u.id = f.follower_id
LEFT JOIN anime_cache bc ON bc.anilist_id = u.backdrop_anilist_id
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
    u.avatar_url,
    bc.cover_image_url AS backdrop_cover_url,
    f.created_at AS followed_at
FROM follows f
JOIN users u ON u.id = f.followee_id
LEFT JOIN anime_cache bc ON bc.anilist_id = u.backdrop_anilist_id
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
    a.banner_image_url,
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
FROM follows follow
WHERE follow.follower_id = $1
  AND NOT EXISTS (
      SELECT 1
      FROM user_blocks block
      WHERE (block.blocker_id = follow.follower_id
             AND block.blocked_id = follow.followee_id)
         OR (block.blocker_id = follow.followee_id
             AND block.blocked_id = follow.follower_id)
  )
ORDER BY follow.created_at DESC
LIMIT 500;

-- name: ListFeedActivities :many
-- Step 2 of /api/feed: append-only activities of the supplied followees.
-- Follow events are stored for future community surfaces but excluded from
-- this first feed contract, whose cards always link to an anime episode.
SELECT
    event.id AS activity_id,
    event.event_type,
    event.user_id,
    COALESCE(event.anilist_id, 0)::integer AS anilist_id,
    COALESCE(event.episode, 0)::integer AS current_episode,
    event.comment_id,
    event.target_user_id,
    event.created_at,
    COALESCE(subscription.status, '')::text AS status,
    event.created_at AS last_watched_at,
    u.username,
    u.avatar_url,
    a.title_romaji,
    a.title_chinese,
    a.cover_image_url,
    visible_comment.content AS comment_content,
    COALESCE(comment.is_spoiler, false)::boolean AS comment_is_spoiler,
    target.username AS target_username,
    target.avatar_url AS target_avatar_url
FROM activity_events event
JOIN users u ON u.id = event.user_id
LEFT JOIN subscriptions subscription
  ON subscription.user_id = event.user_id
 AND subscription.anilist_id = event.anilist_id
LEFT JOIN anime_cache a ON a.anilist_id = event.anilist_id
LEFT JOIN episode_comments comment ON comment.id = event.comment_id
LEFT JOIN episode_comments visible_comment
  ON visible_comment.id = event.comment_id
 AND visible_comment.is_spoiler = false
LEFT JOIN users target ON target.id = event.target_user_id
WHERE event.user_id = ANY($1::uuid[])
  AND u.is_public = true
  AND event.event_type IN ('watch_progress', 'comment')
ORDER BY event.created_at DESC, event.id DESC
LIMIT $2 OFFSET $3;

-- name: CountFeedActivities :one
-- Total for pagination — same filter as ListFeedActivities sans paging.
SELECT count(*) AS total
FROM activity_events event
JOIN users u ON u.id = event.user_id
WHERE event.user_id = ANY($1::uuid[])
  AND u.is_public = true
  AND event.event_type IN ('watch_progress', 'comment');

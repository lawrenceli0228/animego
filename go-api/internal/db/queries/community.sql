-- Durable event, notification, and comment-reaction primitives introduced by
-- migration 0018.  Multi-write user actions live in writable CTEs so callers
-- cannot accidentally commit the primary write without its event/notification.

-- name: CreateActivityEvent :one
INSERT INTO activity_events (
    user_id,
    event_type,
    anilist_id,
    episode,
    comment_id,
    target_user_id
) VALUES (
    sqlc.arg('user_id')::uuid,
    sqlc.arg('event_type')::text,
    sqlc.narg('anilist_id')::integer,
    sqlc.narg('episode')::integer,
    sqlc.narg('comment_id')::uuid,
    sqlc.narg('target_user_id')::uuid
)
RETURNING *;

-- name: InsertNotificationDedupe :one
-- A repeated delivery attempt returns the canonical existing row without
-- resetting read state.  Natural keys are chosen by the caller per event.
--
-- NOTHING CALLS THIS.  Every notification the site writes is emitted inline
-- by the statement that caused it (CreateCommentWithActivity,
-- UpsertCommentReactionWithNotification, UpsertFollowWithActivity), and the
-- one test that mentions this query says why it writes its rows directly
-- instead.
--
-- Left in place, but whoever wires it up must not ship it as it stands: the
-- DO NOTHING + read-back shape below cannot survive two overlapping
-- deliveries of the same dedupe_key.  The conflicting insert waits on the
-- other transaction, but the statement's snapshot predates that wait, so
-- once the other side commits neither arm can see its row and a `:one`
-- query returns pgx.ErrNoRows.  subscriptions.sql's
-- InsertSubscriptionIfAbsent carries the long version of this note and the
-- fix — `notifications` has a single unique constraint on
-- (user_id, dedupe_key), so the same DO UPDATE conflict arm applies here.
WITH inserted AS (
    INSERT INTO notifications (
        user_id,
        actor_id,
        notification_type,
        comment_id,
        activity_event_id,
        dedupe_key
    ) VALUES (
        sqlc.arg('user_id')::uuid,
        sqlc.arg('actor_id')::uuid,
        sqlc.arg('notification_type')::text,
        sqlc.narg('comment_id')::uuid,
        sqlc.narg('activity_event_id')::uuid,
        sqlc.arg('dedupe_key')::text
    )
    ON CONFLICT (user_id, dedupe_key) DO NOTHING
    RETURNING *
)
SELECT * FROM inserted
UNION ALL
SELECT n.*
FROM notifications n
WHERE n.user_id = sqlc.arg('user_id')::uuid
  AND n.dedupe_key = sqlc.arg('dedupe_key')::text
  AND NOT EXISTS (SELECT 1 FROM inserted)
LIMIT 1;

-- name: ListNotifications :many
SELECT
    n.id,
    n.notification_type,
    n.comment_id,
    n.activity_event_id,
    n.read_at,
    n.created_at,
    actor.id AS actor_id,
    actor.username AS actor_username,
    actor.avatar_url AS actor_avatar_url,
    c.anilist_id,
    c.episode,
    visible_comment.content AS comment_content,
    COALESCE(c.is_spoiler, false)::boolean AS comment_is_spoiler,
    a.title_romaji,
    a.title_chinese,
    a.title_hant,
    a.title_hant_source,
    a.title_hant_seo,
    a.cover_image_url
FROM notifications n
JOIN users actor ON actor.id = n.actor_id
LEFT JOIN episode_comments c ON c.id = n.comment_id
LEFT JOIN episode_comments visible_comment
    ON visible_comment.id = n.comment_id
   AND visible_comment.is_spoiler = false
LEFT JOIN anime_cache a ON a.anilist_id = c.anilist_id
WHERE n.user_id = sqlc.arg('user_id')::uuid
  AND NOT EXISTS (
      SELECT 1
      FROM user_blocks block
      WHERE (block.blocker_id = n.user_id AND block.blocked_id = n.actor_id)
         OR (block.blocker_id = n.actor_id AND block.blocked_id = n.user_id)
  )
ORDER BY n.created_at DESC, n.id DESC
LIMIT sqlc.arg('page_limit')::integer;

-- name: CountUnreadNotifications :one
SELECT count(*)::bigint AS unread_count
FROM notifications notification
WHERE notification.user_id = $1
  AND notification.read_at IS NULL
  AND NOT EXISTS (
      SELECT 1
      FROM user_blocks block
      WHERE (block.blocker_id = notification.user_id
             AND block.blocked_id = notification.actor_id)
         OR (block.blocker_id = notification.actor_id
             AND block.blocked_id = notification.user_id)
  );

-- name: MarkNotificationRead :one
UPDATE notifications
SET read_at = COALESCE(read_at, now())
WHERE id = sqlc.arg('notification_id')::uuid
  AND user_id = sqlc.arg('user_id')::uuid
RETURNING *;

-- name: MarkAllNotificationsRead :execrows
UPDATE notifications
SET read_at = now()
WHERE user_id = $1
  AND read_at IS NULL;

-- name: UpsertCommentReaction :one
INSERT INTO comment_reactions (comment_id, user_id, reaction, updated_at)
VALUES ($1, $2, $3, now())
ON CONFLICT (comment_id, user_id) DO UPDATE
SET reaction = EXCLUDED.reaction,
    updated_at = now()
RETURNING *;

-- name: UpsertCommentReactionWithNotification :one
-- The notification is intentionally insert-only on conflict: retrying a like
-- must not turn an already-read notification back into an unread one.
WITH target_comment AS (
    SELECT id, user_id
    FROM episode_comments
    WHERE id = sqlc.arg('comment_id')::uuid
), existing_reaction AS (
    SELECT EXISTS (
        SELECT 1
        FROM comment_reactions
        WHERE comment_id = sqlc.arg('comment_id')::uuid
          AND user_id = sqlc.arg('user_id')::uuid
    ) AS existed
), upserted AS (
    INSERT INTO comment_reactions (comment_id, user_id, reaction, updated_at)
    SELECT
        target.id,
        sqlc.arg('user_id')::uuid,
        'like',
        now()
    FROM target_comment target
    ON CONFLICT (comment_id, user_id) DO UPDATE
    SET reaction = EXCLUDED.reaction,
        updated_at = now()
    RETURNING comment_id
), inserted_notification AS (
    INSERT INTO notifications (
        user_id, actor_id, notification_type, comment_id, dedupe_key
    )
    SELECT
        target.user_id,
        sqlc.arg('user_id')::uuid,
        'reaction',
        target.id,
        'reaction:' || target.id::text || ':' || (sqlc.arg('user_id')::uuid)::text
    FROM target_comment target
    JOIN upserted ON upserted.comment_id = target.id
    WHERE target.user_id <> sqlc.arg('user_id')::uuid
      AND NOT EXISTS (
          SELECT 1
          FROM user_blocks block
          WHERE (block.blocker_id = target.user_id
                 AND block.blocked_id = sqlc.arg('user_id')::uuid)
             OR (block.blocker_id = sqlc.arg('user_id')::uuid
                 AND block.blocked_id = target.user_id)
      )
    ON CONFLICT (user_id, dedupe_key) DO NOTHING
)
SELECT
    EXISTS (SELECT 1 FROM upserted)::boolean AS reacted,
    ((SELECT count(*)
      FROM comment_reactions
      WHERE comment_id = sqlc.arg('comment_id')::uuid)
     + CASE
           WHEN EXISTS (SELECT 1 FROM upserted)
                AND NOT (SELECT existed FROM existing_reaction) THEN 1
           ELSE 0
       END
    )::bigint AS reaction_count;

-- name: DeleteCommentReactionOnly :execrows
DELETE FROM comment_reactions
WHERE comment_id = $1
  AND user_id = $2;

-- name: DeleteCommentReaction :one
WITH deleted AS (
    DELETE FROM comment_reactions
    WHERE comment_id = sqlc.arg('comment_id')::uuid
      AND user_id = sqlc.arg('user_id')::uuid
    RETURNING comment_id
)
SELECT
    false::boolean AS reacted,
    greatest(
        (SELECT count(*)
         FROM comment_reactions
         WHERE comment_id = sqlc.arg('comment_id')::uuid)
        - (SELECT count(*) FROM deleted),
        0
    )::bigint AS reaction_count;

-- name: CountCommentReactions :one
SELECT count(*)::bigint AS reaction_count
FROM comment_reactions
WHERE comment_id = $1;

-- name: HasCommentReaction :one
SELECT EXISTS (
    SELECT 1
    FROM comment_reactions
    WHERE comment_id = $1
      AND user_id = $2
) AS reacted;

-- name: TrackCommunityEngagement :one
-- Aggregate-only counters keep product telemetry useful without retaining a
-- per-user browsing history.  The handler owns the event/target allowlist;
-- matching CHECK constraints make that contract durable at the database edge.
INSERT INTO community_engagement_daily (
    event_date,
    event_type,
    source,
    anilist_id,
    episode,
    authenticated,
    event_count,
    updated_at
) VALUES (
    current_date,
    sqlc.arg('event_type')::text,
    sqlc.arg('source')::text,
    sqlc.arg('anilist_id')::integer,
    sqlc.arg('episode')::integer,
    sqlc.arg('authenticated')::boolean,
    1,
    now()
)
ON CONFLICT (
    event_date,
    event_type,
    source,
    anilist_id,
    episode,
    authenticated
) DO UPDATE
SET event_count = community_engagement_daily.event_count + 1,
    updated_at = now()
RETURNING event_count;

-- name: GetCommunityEngagementSummary :one
-- Two independent pairs, not four interchangeable counters.  Read
-- open_count against impression_count, and welcome_open_count against
-- welcome_impression_count -- never across the pairs.  The two denominators
-- do not count the same renders: hot_discussions_impression is suppressed
-- when the rail has no discussions to show, while welcome_card_impression
-- fires on every mount, because the card it counts renders either way.
-- welcome_impression_count is therefore >= impression_count by construction,
-- and their difference is how often the rail rendered empty.
SELECT
    COALESCE(sum(event_count) FILTER (
        WHERE event_type = 'hot_discussions_impression'
    ), 0)::bigint AS impression_count,
    COALESCE(sum(event_count) FILTER (
        WHERE event_type = 'discussion_open'
    ), 0)::bigint AS open_count,
    COALESCE(sum(event_count) FILTER (
        WHERE event_type = 'welcome_card_impression'
    ), 0)::bigint AS welcome_impression_count,
    COALESCE(sum(event_count) FILTER (
        WHERE event_type = 'welcome_card_open'
    ), 0)::bigint AS welcome_open_count
FROM community_engagement_daily
WHERE event_date >= current_date - (sqlc.arg('day_count')::integer - 1);

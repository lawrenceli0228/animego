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
    c.content AS comment_content,
    a.title_romaji,
    a.title_chinese,
    a.cover_image_url
FROM notifications n
JOIN users actor ON actor.id = n.actor_id
LEFT JOIN episode_comments c ON c.id = n.comment_id
LEFT JOIN anime_cache a ON a.anilist_id = c.anilist_id
WHERE n.user_id = sqlc.arg('user_id')::uuid
ORDER BY n.created_at DESC, n.id DESC
LIMIT sqlc.arg('page_limit')::integer;

-- name: CountUnreadNotifications :one
SELECT count(*)::bigint AS unread_count
FROM notifications
WHERE user_id = $1
  AND read_at IS NULL;

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

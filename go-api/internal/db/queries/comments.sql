-- Queries against episode_comments (P2.5).
--
-- Express's controller returns a flat list sorted by created_at ASC
-- and lets the client render the tree (parent_id adjacency).  We do
-- the same — no recursive CTE needed.  Three endpoints:
--
--   GET    /api/comments/:anilistId/:episode  → ListEpisodeComments
--   POST   /api/comments/:anilistId/:episode  → CreateComment (auth)
--   DELETE /api/comments/:id                  → DeleteComment (auth + own-row check)
--
-- Schema reminders:
--   * id uuid (gen_random_uuid)
--   * parent_id uuid nullable, REFERENCES episode_comments(id) ON DELETE CASCADE
--     → delete-parent automatically cascades children.
--   * content CHECK char_length <= 500 — validated in handler too so the
--     400 error message is friendly.

-- name: ListEpisodeComments :many
-- /api/comments/:anilistId/:episode — flat tree, oldest first.  Hard
-- LIMIT 500 caps abuse (Express has no limit; we add one because
-- pulling 50k rows on a popular episode would blow the response).
SELECT
    c.id,
    c.anilist_id,
    c.episode,
    c.user_id,
    c.username,
    c.content,
    c.is_spoiler,
    c.parent_id,
    c.reply_to_username,
    c.created_at,
    c.updated_at,
    u.avatar_url,
    bc.cover_image_url AS backdrop_cover_url,
    (SELECT count(*)::bigint
     FROM comment_reactions reactions
     WHERE reactions.comment_id = c.id) AS reaction_count,
    (CASE
        WHEN sqlc.narg('viewer_user_id')::uuid IS NULL THEN false
        ELSE EXISTS (
            SELECT 1
            FROM comment_reactions viewer_reaction
            WHERE viewer_reaction.comment_id = c.id
              AND viewer_reaction.user_id = sqlc.narg('viewer_user_id')::uuid
        )
    END)::boolean AS viewer_reacted
FROM episode_comments c
LEFT JOIN users u ON u.id = c.user_id
LEFT JOIN anime_cache bc ON bc.anilist_id = u.backdrop_anilist_id
WHERE c.anilist_id = $1
  AND c.episode = $2
  AND (
      sqlc.narg('viewer_user_id')::uuid IS NULL
      OR NOT EXISTS (
          SELECT 1
          FROM user_blocks block
          WHERE (block.blocker_id = sqlc.narg('viewer_user_id')::uuid
                 AND block.blocked_id = c.user_id)
             OR (block.blocker_id = c.user_id
                 AND block.blocked_id = sqlc.narg('viewer_user_id')::uuid)
      )
  )
ORDER BY c.created_at ASC
LIMIT 500;

-- name: ListEpisodeCommentSummaries :many
-- Comment counts plus the newest N previews per episode for an anime's episode
-- grid.  The window count avoids a second round-trip.  preview_limit is
-- deliberately caller-controlled so desktop/mobile can choose a small payload.
WITH counts AS (
    SELECT episode, count(*)::bigint AS comment_count
    FROM episode_comments comment
    WHERE comment.anilist_id = sqlc.arg('anilist_id')::integer
      AND (
          sqlc.narg('viewer_user_id')::uuid IS NULL
          OR NOT EXISTS (
              SELECT 1
              FROM user_blocks block
              WHERE (block.blocker_id = sqlc.narg('viewer_user_id')::uuid
                     AND block.blocked_id = comment.user_id)
                 OR (block.blocker_id = comment.user_id
                     AND block.blocked_id = sqlc.narg('viewer_user_id')::uuid)
          )
      )
    GROUP BY comment.episode
), ranked AS (
    SELECT
        c.id,
        c.episode,
        c.user_id,
        c.username,
        CASE WHEN c.is_spoiler THEN '' ELSE c.content END::text AS content,
        c.is_spoiler,
        c.parent_id,
        c.reply_to_username,
        c.created_at,
        u.avatar_url,
        backdrop.cover_image_url AS backdrop_cover_url,
        row_number() OVER (
            PARTITION BY c.episode
            ORDER BY c.created_at DESC, c.id DESC
        ) AS preview_rank
    FROM episode_comments c
    LEFT JOIN users u ON u.id = c.user_id
    LEFT JOIN anime_cache backdrop ON backdrop.anilist_id = u.backdrop_anilist_id
    WHERE c.anilist_id = sqlc.arg('anilist_id')::integer
      AND c.parent_id IS NULL
      AND (
          sqlc.narg('viewer_user_id')::uuid IS NULL
          OR NOT EXISTS (
              SELECT 1
              FROM user_blocks block
              WHERE (block.blocker_id = sqlc.narg('viewer_user_id')::uuid
                     AND block.blocked_id = c.user_id)
                 OR (block.blocker_id = c.user_id
                     AND block.blocked_id = sqlc.narg('viewer_user_id')::uuid)
          )
      )
)
SELECT
    ranked.id,
    ranked.episode,
    ranked.user_id,
    ranked.username,
    ranked.content,
    ranked.is_spoiler,
    ranked.parent_id,
    ranked.reply_to_username,
    ranked.created_at,
    ranked.avatar_url,
    ranked.backdrop_cover_url,
    counts.comment_count
FROM ranked
JOIN counts USING (episode)
WHERE preview_rank <= sqlc.arg('preview_limit')::integer
ORDER BY ranked.episode ASC, ranked.created_at DESC, ranked.id DESC;

-- name: CreateComment :one
-- POST /api/comments/:anilistId/:episode.  Caller has already
-- validated content length + parent existence.  parent_id may be NULL
-- (top-level comment) or a uuid pointer.  reply_to_username is a
-- denormalised string used by the frontend to render "@username"
-- prefix; nullable.
INSERT INTO episode_comments (
    anilist_id,
    episode,
    user_id,
    username,
    content,
    is_spoiler,
    parent_id,
    reply_to_username
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING
    id,
    anilist_id,
    episode,
    user_id,
    username,
    content,
    parent_id,
    reply_to_username,
    created_at,
    updated_at,
    is_spoiler;

-- name: CreateCommentWithActivity :one
-- Atomic community write: create the comment, append its feed event, and (for
-- a non-self reply) enqueue one deduped notification.  The parent validation
-- query remains useful for returning a friendly 400 before this is called.
WITH inserted_comment AS (
    INSERT INTO episode_comments (
        anilist_id,
        episode,
        user_id,
        username,
        content,
        is_spoiler,
        parent_id,
        reply_to_username
    ) VALUES (
        sqlc.arg('anilist_id')::integer,
        sqlc.arg('episode')::integer,
        sqlc.arg('user_id')::uuid,
        sqlc.arg('username')::text,
        sqlc.arg('content')::text,
        sqlc.arg('is_spoiler')::boolean,
        sqlc.narg('parent_id')::uuid,
        sqlc.narg('reply_to_username')::text
    )
    RETURNING *
), inserted_activity AS (
    INSERT INTO activity_events (
        user_id, event_type, anilist_id, episode, comment_id
    )
    SELECT user_id, 'comment', anilist_id, episode, id
    FROM inserted_comment
    RETURNING id
), inserted_notification AS (
    INSERT INTO notifications (
        user_id,
        actor_id,
        notification_type,
        comment_id,
        activity_event_id,
        dedupe_key
    )
    SELECT
        parent.user_id,
        comment.user_id,
        'reply',
        comment.id,
        activity.id,
        'reply:' || comment.id::text
    FROM inserted_comment comment
    JOIN episode_comments parent ON parent.id = comment.parent_id
    CROSS JOIN inserted_activity activity
    WHERE parent.user_id <> comment.user_id
      AND NOT EXISTS (
          SELECT 1
          FROM user_blocks block
          WHERE (block.blocker_id = parent.user_id
                 AND block.blocked_id = comment.user_id)
             OR (block.blocker_id = comment.user_id
                 AND block.blocked_id = parent.user_id)
      )
    ON CONFLICT (user_id, dedupe_key) DO NOTHING
)
SELECT
    id,
    anilist_id,
    episode,
    user_id,
    username,
    content,
    is_spoiler,
    parent_id,
    reply_to_username,
    created_at,
    updated_at
FROM inserted_comment;

-- name: GetCommentParentForValidation :one
-- Pre-INSERT check: confirms the supplied parent_id exists AND points
-- at the same (anilist_id, episode) — defense against cross-thread
-- reply abuse (someone passing a random comment id from a different
-- episode).  ErrNoRows → handler 400 "Parent comment not found".
SELECT id
FROM episode_comments
WHERE id = $1
  AND anilist_id = $2
  AND episode = $3;

-- name: GetCommentByID :one
-- DELETE pre-check: read the row so we can confirm ownership before
-- deleting.  Returns the user_id the comment was authored by; handler
-- compares against claims.UserID.
SELECT
    id,
    user_id
FROM episode_comments
WHERE id = $1;

-- name: DeleteComment :exec
-- DELETE /api/comments/:id.  ON DELETE CASCADE handles any reply
-- children — Express deleteOne() left them dangling, which is a bug
-- the Postgres FK definition fixes for free.
DELETE FROM episode_comments
WHERE id = $1;

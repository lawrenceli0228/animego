-- Community safety data access introduced by migration 0019.

-- name: BlockUser :one
-- Blocking is one atomic boundary: create the directional block and sever all
-- social/notification edges between the two users. Repeating the request is
-- idempotent and still cleans up any stale edges.
WITH inserted_block AS (
    INSERT INTO user_blocks (blocker_id, blocked_id)
    VALUES (
        sqlc.arg('blocker_id')::uuid,
        sqlc.arg('blocked_id')::uuid
    )
    ON CONFLICT (blocker_id, blocked_id) DO NOTHING
    RETURNING blocker_id
), removed_follows AS (
    DELETE FROM follows
    WHERE (follower_id = sqlc.arg('blocker_id')::uuid
           AND followee_id = sqlc.arg('blocked_id')::uuid)
       OR (follower_id = sqlc.arg('blocked_id')::uuid
           AND followee_id = sqlc.arg('blocker_id')::uuid)
    RETURNING follower_id
), removed_notifications AS (
    DELETE FROM notifications
    WHERE (user_id = sqlc.arg('blocker_id')::uuid
           AND actor_id = sqlc.arg('blocked_id')::uuid)
       OR (user_id = sqlc.arg('blocked_id')::uuid
           AND actor_id = sqlc.arg('blocker_id')::uuid)
    RETURNING id
), removed_reactions AS (
    DELETE FROM comment_reactions reaction
    USING episode_comments comment
    WHERE reaction.comment_id = comment.id
      AND (
          (reaction.user_id = sqlc.arg('blocker_id')::uuid
           AND comment.user_id = sqlc.arg('blocked_id')::uuid)
          OR
          (reaction.user_id = sqlc.arg('blocked_id')::uuid
           AND comment.user_id = sqlc.arg('blocker_id')::uuid)
      )
    RETURNING reaction.comment_id
)
SELECT
    EXISTS (SELECT 1 FROM inserted_block)::boolean AS inserted,
    (SELECT count(*) FROM removed_follows)::bigint AS removed_follows,
    (SELECT count(*) FROM removed_notifications)::bigint AS removed_notifications,
    (SELECT count(*) FROM removed_reactions)::bigint AS removed_reactions;

-- name: UnblockUser :execrows
DELETE FROM user_blocks
WHERE blocker_id = $1
  AND blocked_id = $2;

-- name: ListUserBlocks :many
SELECT
    block.blocked_id,
    blocked.username,
    blocked.avatar_url,
    backdrop.cover_image_url AS backdrop_cover_url,
    block.created_at
FROM user_blocks block
JOIN users blocked ON blocked.id = block.blocked_id
LEFT JOIN anime_cache backdrop
    ON backdrop.anilist_id = blocked.backdrop_anilist_id
WHERE block.blocker_id = $1
ORDER BY block.created_at DESC, block.blocked_id DESC
LIMIT $2 OFFSET $3;

-- name: UserBlockExists :one
-- Product policy is symmetric: either user's block closes interaction in both
-- directions even though only the initiator owns the row.
SELECT EXISTS (
    SELECT 1
    FROM user_blocks
    WHERE (blocker_id = sqlc.arg('user_id')::uuid
           AND blocked_id = sqlc.arg('other_user_id')::uuid)
       OR (blocker_id = sqlc.arg('other_user_id')::uuid
           AND blocked_id = sqlc.arg('user_id')::uuid)
) AS is_blocked;

-- name: UserBlockedTarget :one
-- Directional companion for profile/UI state: true only when the first user
-- owns the block row against the second user.
SELECT EXISTS (
    SELECT 1
    FROM user_blocks
    WHERE blocker_id = $1
      AND blocked_id = $2
) AS blocked_target;

-- name: CreatePendingReport :one
-- A repeated report while the first is pending returns that canonical report.
-- Once moderation moves it out of pending the reporter may file a new report.
WITH report_target AS (
    SELECT
        comment.id AS target_comment_id,
        NULL::uuid AS target_user_id,
        jsonb_build_object(
            'username', author.username,
            'content', comment.content,
            'isSpoiler', comment.is_spoiler,
            'anilistId', comment.anilist_id,
            'episode', comment.episode
        ) AS target_snapshot
    FROM episode_comments comment
    JOIN users author ON author.id = comment.user_id
    WHERE sqlc.arg('target_type')::text = 'comment'
      AND comment.id = sqlc.narg('target_comment_id')::uuid

    UNION ALL

    SELECT
        NULL::uuid AS target_comment_id,
        target_user.id AS target_user_id,
        jsonb_build_object('username', target_user.username) AS target_snapshot
    FROM users target_user
    WHERE sqlc.arg('target_type')::text = 'user'
      AND target_user.id = sqlc.narg('target_user_id')::uuid
), inserted_report AS (
    INSERT INTO reports (
        reporter_id,
        target_type,
        target_comment_id,
        target_user_id,
        target_snapshot,
        reason,
        details
    )
    SELECT
        sqlc.arg('reporter_id')::uuid,
        sqlc.arg('target_type')::text,
        target.target_comment_id,
        target.target_user_id,
        target.target_snapshot,
        sqlc.arg('reason')::text,
        sqlc.narg('details')::text
    FROM report_target target
    ON CONFLICT DO NOTHING
    RETURNING *
)
SELECT * FROM inserted_report
UNION ALL
SELECT report.*
FROM reports report
WHERE report.reporter_id = sqlc.arg('reporter_id')::uuid
  AND report.target_type = sqlc.arg('target_type')::text
  AND report.status = 'pending'
  AND (
      (report.target_type = 'comment'
       AND report.target_comment_id = sqlc.narg('target_comment_id')::uuid)
      OR
      (report.target_type = 'user'
       AND report.target_user_id = sqlc.narg('target_user_id')::uuid)
  )
  AND NOT EXISTS (SELECT 1 FROM inserted_report)
LIMIT 1;

-- name: ListReports :many
-- Passing NULL report_status returns the entire moderation queue.
SELECT
    report.id,
    report.reporter_id,
    reporter.username AS reporter_username,
    report.target_type,
    report.target_comment_id,
    report.target_user_id,
    report.target_snapshot,
    target_user.username AS target_username,
    target_comment.content AS target_comment_content,
    target_comment.is_spoiler AS target_comment_is_spoiler,
    target_comment.anilist_id AS target_comment_anilist_id,
    target_comment.episode AS target_comment_episode,
    report.reason,
    report.details,
    report.status,
    report.resolution_note,
    report.reviewed_by,
    reviewer.username AS reviewer_username,
    report.reviewed_at,
    report.created_at,
    report.updated_at
FROM reports report
JOIN users reporter ON reporter.id = report.reporter_id
LEFT JOIN users target_user ON target_user.id = report.target_user_id
LEFT JOIN episode_comments target_comment
    ON target_comment.id = report.target_comment_id
LEFT JOIN users reviewer ON reviewer.id = report.reviewed_by
WHERE sqlc.narg('report_status')::text IS NULL
   OR report.status = sqlc.narg('report_status')::text
ORDER BY report.created_at ASC, report.id ASC
LIMIT sqlc.arg('page_limit')::integer
OFFSET sqlc.arg('page_offset')::integer;

-- name: UpdateReport :one
UPDATE reports
SET status = sqlc.arg('report_status')::text,
    resolution_note = sqlc.narg('resolution_note')::text,
    reviewed_by = sqlc.arg('reviewed_by')::uuid,
    reviewed_at = now(),
    updated_at = now()
WHERE id = sqlc.arg('report_id')::uuid
RETURNING *;

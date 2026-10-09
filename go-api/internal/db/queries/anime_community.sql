-- The community tab of an anime page (migration 0046): reviews, review
-- helpful votes, discussion threads, replies under a thread or an activity
-- event, activity likes, and who is following the anime.
--
-- Read rules every list here follows:
--   * soft-deleted rows (deleted_at IS NOT NULL) are never returned;
--   * a private review is returned only to its author — the predicate
--     `NOT r.is_private OR r.user_id = viewer_id` is NULL, hence false, for
--     an anonymous viewer;
--   * for a signed-in viewer, nothing written by someone on either side of a
--     block with them (user_blocks is read symmetrically, as everywhere else);
--   * activity and the follower list show only users whose profile is
--     public (users.is_public), except to the user themselves — the same
--     line the public profile and /api/feed draw.
--
-- Writes that notify do it in the same statement, as CreateCommentWithActivity
-- does, so a reply can never commit without its notification or vice versa.

-- name: CommunityAnimeExists :one
-- Every community endpoint answers 404 for an anime the catalogue does not
-- hold.  Read-only on purpose: these endpoints never fetch from AniList.
SELECT EXISTS (
    SELECT 1 FROM anime_cache WHERE anilist_id = $1
) AS present;

-- ==================== Reviews ====================

-- name: QueryAnimeReviews :many
-- One review shape for three callers: the list (review_id and author_id
-- NULL), a single review (review_id), and the viewer's own (author_id).
-- Sorted by how many found it helpful, then newest.  helpful_count is
-- computed, not stored: one row per vote is the only record, so the number
-- cannot drift from it.
SELECT
    r.id,
    r.anilist_id,
    r.user_id,
    u.username,
    u.avatar_url,
    backdrop.cover_image_url AS backdrop_cover_url,
    r.summary,
    r.body,
    r.is_spoiler,
    r.is_private,
    r.created_at,
    r.updated_at,
    (SELECT count(*)
     FROM anime_review_votes vote
     WHERE vote.review_id = r.id)::bigint AS helpful_count,
    (CASE
        WHEN sqlc.narg('viewer_id')::uuid IS NULL THEN false
        ELSE EXISTS (
            SELECT 1
            FROM anime_review_votes vote
            WHERE vote.review_id = r.id
              AND vote.user_id = sqlc.narg('viewer_id')::uuid
        )
    END)::boolean AS viewer_voted
FROM anime_reviews r
JOIN users u ON u.id = r.user_id
LEFT JOIN anime_cache backdrop ON backdrop.anilist_id = u.backdrop_anilist_id
WHERE r.anilist_id = sqlc.arg('anilist_id')::integer
  AND r.deleted_at IS NULL
  AND (sqlc.narg('review_id')::uuid IS NULL OR r.id = sqlc.narg('review_id')::uuid)
  AND (sqlc.narg('author_id')::uuid IS NULL OR r.user_id = sqlc.narg('author_id')::uuid)
  AND (NOT r.is_private OR r.user_id = sqlc.narg('viewer_id')::uuid)
  AND (
      sqlc.narg('viewer_id')::uuid IS NULL
      OR NOT EXISTS (
          SELECT 1
          FROM user_blocks block
          WHERE (block.blocker_id = sqlc.narg('viewer_id')::uuid AND block.blocked_id = r.user_id)
             OR (block.blocker_id = r.user_id AND block.blocked_id = sqlc.narg('viewer_id')::uuid)
      )
  )
ORDER BY helpful_count DESC, r.created_at DESC, r.id DESC
LIMIT sqlc.arg('page_limit')::integer
OFFSET sqlc.arg('page_offset')::integer;

-- name: CountAnimeReviews :one
-- The total behind QueryAnimeReviews' list form, same visibility rules.
SELECT count(*)::bigint AS total
FROM anime_reviews r
WHERE r.anilist_id = sqlc.arg('anilist_id')::integer
  AND r.deleted_at IS NULL
  AND (NOT r.is_private OR r.user_id = sqlc.narg('viewer_id')::uuid)
  AND (
      sqlc.narg('viewer_id')::uuid IS NULL
      OR NOT EXISTS (
          SELECT 1
          FROM user_blocks block
          WHERE (block.blocker_id = sqlc.narg('viewer_id')::uuid AND block.blocked_id = r.user_id)
             OR (block.blocker_id = r.user_id AND block.blocked_id = sqlc.narg('viewer_id')::uuid)
      )
  );

-- name: GetAnimeReviewMeta :one
-- Ownership and state of one review, for the write paths to tell "not
-- found" from "not yours".  Deleted rows are returned (deleted = true) so the
-- caller decides; nothing here filters on the viewer.
SELECT
    r.id,
    r.anilist_id,
    r.user_id,
    r.is_private,
    (r.deleted_at IS NOT NULL)::boolean AS deleted
FROM anime_reviews r
WHERE r.id = $1;

-- name: CreateAnimeReview :one
-- One live review per user per anime: a second insert trips the partial
-- unique index anime_reviews_one_live_per_user (23505), which the handler
-- answers with 409.
INSERT INTO anime_reviews (anilist_id, user_id, summary, body, is_spoiler, is_private)
VALUES (
    sqlc.arg('anilist_id')::integer,
    sqlc.arg('user_id')::uuid,
    sqlc.arg('summary')::text,
    sqlc.arg('body')::text,
    sqlc.arg('is_spoiler')::boolean,
    sqlc.arg('is_private')::boolean
)
RETURNING id;

-- name: UpdateAnimeReview :one
-- Author-only, enforced here as well as by the handler: a request for
-- someone else's review matches no row.
UPDATE anime_reviews
SET summary    = sqlc.arg('summary')::text,
    body       = sqlc.arg('body')::text,
    is_spoiler = sqlc.arg('is_spoiler')::boolean,
    is_private = sqlc.arg('is_private')::boolean,
    updated_at = now()
WHERE id = sqlc.arg('review_id')::uuid
  AND user_id = sqlc.arg('user_id')::uuid
  AND deleted_at IS NULL
RETURNING id;

-- name: SoftDeleteAnimeReview :execrows
-- The author's delete and an admin's removal are the same write; deleted_by
-- records which.  Already-deleted rows are left alone (0 rows).
UPDATE anime_reviews
SET deleted_at = now(),
    deleted_by = sqlc.arg('actor_id')::uuid,
    updated_at = now()
WHERE id = sqlc.arg('review_id')::uuid
  AND deleted_at IS NULL;

-- name: AddReviewHelpfulVote :one
-- Idempotent.  The count is read from the statement's snapshot, which
-- cannot see the row this statement inserts, hence the + inserted (the same
-- arithmetic UpsertCommentReactionWithNotification does).
WITH inserted AS (
    INSERT INTO anime_review_votes (review_id, user_id)
    VALUES (sqlc.arg('review_id')::uuid, sqlc.arg('user_id')::uuid)
    ON CONFLICT (review_id, user_id) DO NOTHING
    RETURNING review_id
)
SELECT (
    (SELECT count(*) FROM anime_review_votes WHERE review_id = sqlc.arg('review_id')::uuid)
    + (SELECT count(*) FROM inserted)
)::bigint AS helpful_count;

-- name: RemoveReviewHelpfulVote :one
WITH deleted AS (
    DELETE FROM anime_review_votes
    WHERE review_id = sqlc.arg('review_id')::uuid
      AND user_id = sqlc.arg('user_id')::uuid
    RETURNING review_id
)
SELECT greatest(
    (SELECT count(*) FROM anime_review_votes WHERE review_id = sqlc.arg('review_id')::uuid)
    - (SELECT count(*) FROM deleted),
    0
)::bigint AS helpful_count;

-- ==================== Threads ====================

-- name: ListAnimeThreads :many
-- Busiest conversation first: a reply moves last_activity_at.  The list
-- carries the first 200 characters of the body, enough for an excerpt; the
-- thread view reads the whole of it through GetAnimeThread.
SELECT
    t.id,
    t.anilist_id,
    t.user_id,
    u.username,
    u.avatar_url,
    backdrop.cover_image_url AS backdrop_cover_url,
    t.title,
    left(t.body, 200)::text AS body_excerpt,
    t.is_spoiler,
    t.created_at,
    t.last_activity_at,
    (SELECT count(*)
     FROM community_replies reply
     WHERE reply.thread_id = t.id
       AND reply.deleted_at IS NULL
       AND (
           sqlc.narg('viewer_id')::uuid IS NULL
           OR NOT EXISTS (
               SELECT 1
               FROM user_blocks block
               WHERE (block.blocker_id = sqlc.narg('viewer_id')::uuid AND block.blocked_id = reply.user_id)
                  OR (block.blocker_id = reply.user_id AND block.blocked_id = sqlc.narg('viewer_id')::uuid)
           )
       ))::bigint AS reply_count
FROM anime_threads t
JOIN users u ON u.id = t.user_id
LEFT JOIN anime_cache backdrop ON backdrop.anilist_id = u.backdrop_anilist_id
WHERE t.anilist_id = sqlc.arg('anilist_id')::integer
  AND t.deleted_at IS NULL
  AND (
      sqlc.narg('viewer_id')::uuid IS NULL
      OR NOT EXISTS (
          SELECT 1
          FROM user_blocks block
          WHERE (block.blocker_id = sqlc.narg('viewer_id')::uuid AND block.blocked_id = t.user_id)
             OR (block.blocker_id = t.user_id AND block.blocked_id = sqlc.narg('viewer_id')::uuid)
      )
  )
ORDER BY t.last_activity_at DESC, t.id DESC
LIMIT sqlc.arg('page_limit')::integer
OFFSET sqlc.arg('page_offset')::integer;

-- name: CountAnimeThreads :one
SELECT count(*)::bigint AS total
FROM anime_threads t
WHERE t.anilist_id = sqlc.arg('anilist_id')::integer
  AND t.deleted_at IS NULL
  AND (
      sqlc.narg('viewer_id')::uuid IS NULL
      OR NOT EXISTS (
          SELECT 1
          FROM user_blocks block
          WHERE (block.blocker_id = sqlc.narg('viewer_id')::uuid AND block.blocked_id = t.user_id)
             OR (block.blocker_id = t.user_id AND block.blocked_id = sqlc.narg('viewer_id')::uuid)
      )
  );

-- name: GetAnimeThread :one
-- The thread view.  A viewer on either side of a block with the author gets
-- nothing, the same as the list.
SELECT
    t.id,
    t.anilist_id,
    t.user_id,
    u.username,
    u.avatar_url,
    backdrop.cover_image_url AS backdrop_cover_url,
    t.title,
    t.body,
    t.is_spoiler,
    t.created_at,
    t.updated_at,
    t.last_activity_at
FROM anime_threads t
JOIN users u ON u.id = t.user_id
LEFT JOIN anime_cache backdrop ON backdrop.anilist_id = u.backdrop_anilist_id
WHERE t.id = sqlc.arg('thread_id')::uuid
  AND t.anilist_id = sqlc.arg('anilist_id')::integer
  AND t.deleted_at IS NULL
  AND (
      sqlc.narg('viewer_id')::uuid IS NULL
      OR NOT EXISTS (
          SELECT 1
          FROM user_blocks block
          WHERE (block.blocker_id = sqlc.narg('viewer_id')::uuid AND block.blocked_id = t.user_id)
             OR (block.blocker_id = t.user_id AND block.blocked_id = sqlc.narg('viewer_id')::uuid)
      )
  );

-- name: GetAnimeThreadMeta :one
SELECT
    t.id,
    t.anilist_id,
    t.user_id,
    (t.deleted_at IS NOT NULL)::boolean AS deleted
FROM anime_threads t
WHERE t.id = $1;

-- name: CreateAnimeThread :one
INSERT INTO anime_threads (anilist_id, user_id, title, body, is_spoiler)
VALUES (
    sqlc.arg('anilist_id')::integer,
    sqlc.arg('user_id')::uuid,
    sqlc.arg('title')::text,
    sqlc.arg('body')::text,
    sqlc.arg('is_spoiler')::boolean
)
RETURNING id;

-- name: SoftDeleteAnimeThread :one
-- Removing a thread also removes the notifications its replies sent: an
-- inbox must not link into a thread that answers 404.  The replies
-- themselves stay as they are, unreachable behind the deleted thread.
WITH deleted AS (
    UPDATE anime_threads
    SET deleted_at = now(),
        deleted_by = sqlc.arg('actor_id')::uuid,
        updated_at = now()
    WHERE id = sqlc.arg('thread_id')::uuid
      AND deleted_at IS NULL
    RETURNING id
), removed_notifications AS (
    DELETE FROM notifications notification
    USING community_replies reply, deleted
    WHERE notification.reply_id = reply.id
      AND reply.thread_id = deleted.id
    RETURNING notification.id
)
SELECT count(*)::bigint AS deleted FROM deleted;

-- ==================== Replies ====================

-- name: ListThreadReplies :many
-- Oldest first, like episode comments.  Capped at 500 — far past any thread
-- this site has, and a bound on what one request can ask Postgres for.
-- reply_to_username names who a reply answers, read through its parent even
-- when that parent was since deleted.
SELECT
    reply.id,
    reply.user_id,
    u.username,
    u.avatar_url,
    backdrop.cover_image_url AS backdrop_cover_url,
    reply.body,
    reply.is_spoiler,
    reply.parent_id,
    parent_author.username AS reply_to_username,
    reply.created_at
FROM community_replies reply
JOIN users u ON u.id = reply.user_id
LEFT JOIN anime_cache backdrop ON backdrop.anilist_id = u.backdrop_anilist_id
LEFT JOIN community_replies parent ON parent.id = reply.parent_id
LEFT JOIN users parent_author ON parent_author.id = parent.user_id
WHERE reply.thread_id = sqlc.arg('thread_id')::uuid
  AND reply.deleted_at IS NULL
  AND (
      sqlc.narg('viewer_id')::uuid IS NULL
      OR NOT EXISTS (
          SELECT 1
          FROM user_blocks block
          WHERE (block.blocker_id = sqlc.narg('viewer_id')::uuid AND block.blocked_id = reply.user_id)
             OR (block.blocker_id = reply.user_id AND block.blocked_id = sqlc.narg('viewer_id')::uuid)
      )
  )
ORDER BY reply.created_at ASC, reply.id ASC
LIMIT 500;

-- name: ListActivityReplies :many
-- The replies under a page of activity events, oldest first, at most
-- per_event_limit for each.  One query for the whole page rather than one
-- per event.
SELECT
    ranked.id,
    ranked.activity_event_id,
    ranked.user_id,
    ranked.username,
    ranked.avatar_url,
    ranked.backdrop_cover_url,
    ranked.body,
    ranked.is_spoiler,
    ranked.parent_id,
    ranked.reply_to_username,
    ranked.created_at
FROM (
    SELECT
        reply.id,
        reply.activity_event_id,
        reply.user_id,
        u.username,
        u.avatar_url,
        backdrop.cover_image_url AS backdrop_cover_url,
        reply.body,
        reply.is_spoiler,
        reply.parent_id,
        parent_author.username AS reply_to_username,
        reply.created_at,
        row_number() OVER (
            PARTITION BY reply.activity_event_id
            ORDER BY reply.created_at ASC, reply.id ASC
        ) AS position
    FROM community_replies reply
    JOIN users u ON u.id = reply.user_id
    LEFT JOIN anime_cache backdrop ON backdrop.anilist_id = u.backdrop_anilist_id
    LEFT JOIN community_replies parent ON parent.id = reply.parent_id
    LEFT JOIN users parent_author ON parent_author.id = parent.user_id
    WHERE reply.activity_event_id = ANY(sqlc.arg('event_ids')::uuid[])
      AND reply.deleted_at IS NULL
      AND (
          sqlc.narg('viewer_id')::uuid IS NULL
          OR NOT EXISTS (
              SELECT 1
              FROM user_blocks block
              WHERE (block.blocker_id = sqlc.narg('viewer_id')::uuid AND block.blocked_id = reply.user_id)
                 OR (block.blocker_id = reply.user_id AND block.blocked_id = sqlc.narg('viewer_id')::uuid)
          )
      )
) ranked
WHERE ranked.position <= sqlc.arg('per_event_limit')::integer
ORDER BY ranked.activity_event_id, ranked.created_at ASC, ranked.id ASC;

-- name: GetCommunityReply :one
-- One live reply in the list shape, for a write to answer with what it wrote.
SELECT
    reply.id,
    reply.user_id,
    u.username,
    u.avatar_url,
    backdrop.cover_image_url AS backdrop_cover_url,
    reply.body,
    reply.is_spoiler,
    reply.parent_id,
    parent_author.username AS reply_to_username,
    reply.created_at
FROM community_replies reply
JOIN users u ON u.id = reply.user_id
LEFT JOIN anime_cache backdrop ON backdrop.anilist_id = u.backdrop_anilist_id
LEFT JOIN community_replies parent ON parent.id = reply.parent_id
LEFT JOIN users parent_author ON parent_author.id = parent.user_id
WHERE reply.id = $1
  AND reply.deleted_at IS NULL;

-- name: GetCommunityReplyMeta :one
SELECT
    reply.id,
    reply.anilist_id,
    reply.user_id,
    reply.thread_id,
    reply.activity_event_id,
    (reply.deleted_at IS NOT NULL)::boolean AS deleted
FROM community_replies reply
WHERE reply.id = $1;

-- name: CreateThreadReply :one
-- Insert the reply, move the thread up the list, and notify the thread's
-- author and — when this answers another reply — that reply's author.  The
-- UNION collapses the two when they are the same person; nobody is notified
-- of their own reply, and nobody across a block.  A thread deleted between
-- the handler's check and this statement yields no row (handler: 404).
WITH thread AS (
    SELECT t.id, t.anilist_id, t.user_id
    FROM anime_threads t
    WHERE t.id = sqlc.arg('thread_id')::uuid
      AND t.deleted_at IS NULL
), parent AS (
    SELECT p.id, p.user_id
    FROM community_replies p
    WHERE p.id = sqlc.narg('parent_id')::uuid
      AND p.thread_id = sqlc.arg('thread_id')::uuid
      AND p.deleted_at IS NULL
), inserted AS (
    INSERT INTO community_replies (anilist_id, thread_id, parent_id, user_id, body, is_spoiler)
    SELECT
        thread.anilist_id,
        thread.id,
        (SELECT parent.id FROM parent),
        sqlc.arg('user_id')::uuid,
        sqlc.arg('body')::text,
        sqlc.arg('is_spoiler')::boolean
    FROM thread
    RETURNING id, user_id, created_at
), bumped AS (
    UPDATE anime_threads t
    SET last_activity_at = now()
    FROM thread
    WHERE t.id = thread.id
      AND EXISTS (SELECT 1 FROM inserted)
    RETURNING t.id
), recipients AS (
    SELECT thread.user_id AS recipient_id FROM thread
    UNION
    SELECT parent.user_id FROM parent
), notified AS (
    INSERT INTO notifications (user_id, actor_id, notification_type, reply_id, dedupe_key)
    SELECT
        recipient.recipient_id,
        inserted.user_id,
        'thread_reply',
        inserted.id,
        'thread_reply:' || inserted.id::text
    FROM recipients recipient
    CROSS JOIN inserted
    WHERE recipient.recipient_id <> inserted.user_id
      AND NOT EXISTS (
          SELECT 1
          FROM user_blocks block
          WHERE (block.blocker_id = recipient.recipient_id AND block.blocked_id = inserted.user_id)
             OR (block.blocker_id = inserted.user_id AND block.blocked_id = recipient.recipient_id)
      )
    ON CONFLICT (user_id, dedupe_key) DO NOTHING
    RETURNING id
)
SELECT inserted.id, inserted.created_at FROM inserted;

-- name: CreateActivityReply :one
-- CreateThreadReply's shape under an activity event: notify the event's
-- owner (and the author of the reply this answers), never oneself, never
-- across a block.  Only status events — the ones the tab lists — take
-- replies, and only while their owner's profile is public (or the replier
-- is the owner).
WITH event AS (
    SELECT e.id, e.anilist_id, e.user_id
    FROM activity_events e
    JOIN users owner ON owner.id = e.user_id
    WHERE e.id = sqlc.arg('event_id')::uuid
      AND e.event_type = 'status'
      AND e.anilist_id IS NOT NULL
      AND (owner.is_public OR e.user_id = sqlc.arg('user_id')::uuid)
), parent AS (
    SELECT p.id, p.user_id
    FROM community_replies p
    WHERE p.id = sqlc.narg('parent_id')::uuid
      AND p.activity_event_id = sqlc.arg('event_id')::uuid
      AND p.deleted_at IS NULL
), inserted AS (
    INSERT INTO community_replies (anilist_id, activity_event_id, parent_id, user_id, body)
    SELECT
        event.anilist_id,
        event.id,
        (SELECT parent.id FROM parent),
        sqlc.arg('user_id')::uuid,
        sqlc.arg('body')::text
    FROM event
    RETURNING id, user_id, activity_event_id, created_at
), recipients AS (
    SELECT event.user_id AS recipient_id FROM event
    UNION
    SELECT parent.user_id FROM parent
), notified AS (
    INSERT INTO notifications (
        user_id, actor_id, notification_type, reply_id, activity_event_id, dedupe_key
    )
    SELECT
        recipient.recipient_id,
        inserted.user_id,
        'activity_reply',
        inserted.id,
        inserted.activity_event_id,
        'activity_reply:' || inserted.id::text
    FROM recipients recipient
    CROSS JOIN inserted
    WHERE recipient.recipient_id <> inserted.user_id
      AND NOT EXISTS (
          SELECT 1
          FROM user_blocks block
          WHERE (block.blocker_id = recipient.recipient_id AND block.blocked_id = inserted.user_id)
             OR (block.blocker_id = inserted.user_id AND block.blocked_id = recipient.recipient_id)
      )
    ON CONFLICT (user_id, dedupe_key) DO NOTHING
    RETURNING id
)
SELECT inserted.id, inserted.created_at FROM inserted;

-- name: SoftDeleteCommunityReply :one
-- The reply's notifications go in the same statement, so an inbox never
-- quotes a reply its author took back.
WITH deleted AS (
    UPDATE community_replies
    SET deleted_at = now(),
        deleted_by = sqlc.arg('actor_id')::uuid,
        updated_at = now()
    WHERE id = sqlc.arg('reply_id')::uuid
      AND deleted_at IS NULL
    RETURNING id
), removed_notifications AS (
    DELETE FROM notifications notification
    USING deleted
    WHERE notification.reply_id = deleted.id
    RETURNING notification.id
)
SELECT count(*)::bigint AS deleted FROM deleted;

-- ==================== Activity ====================

-- name: QueryAnimeActivity :many
-- The tab's 最近动态: one anime's status events, newest first, with their
-- like and reply counts.  event_id narrows it to one event (a notification
-- links to an event that may be past the first page).
SELECT
    e.id,
    e.user_id,
    u.username,
    u.avatar_url,
    backdrop.cover_image_url AS backdrop_cover_url,
    COALESCE(e.status, '')::text AS status,
    e.created_at,
    (SELECT count(*)
     FROM activity_likes l
     WHERE l.activity_event_id = e.id)::bigint AS like_count,
    (CASE
        WHEN sqlc.narg('viewer_id')::uuid IS NULL THEN false
        ELSE EXISTS (
            SELECT 1
            FROM activity_likes l
            WHERE l.activity_event_id = e.id
              AND l.user_id = sqlc.narg('viewer_id')::uuid
        )
    END)::boolean AS viewer_liked,
    (SELECT count(*)
     FROM community_replies reply
     WHERE reply.activity_event_id = e.id
       AND reply.deleted_at IS NULL
       AND (
           sqlc.narg('viewer_id')::uuid IS NULL
           OR NOT EXISTS (
               SELECT 1
               FROM user_blocks block
               WHERE (block.blocker_id = sqlc.narg('viewer_id')::uuid AND block.blocked_id = reply.user_id)
                  OR (block.blocker_id = reply.user_id AND block.blocked_id = sqlc.narg('viewer_id')::uuid)
           )
       ))::bigint AS reply_count
FROM activity_events e
JOIN users u ON u.id = e.user_id
LEFT JOIN anime_cache backdrop ON backdrop.anilist_id = u.backdrop_anilist_id
WHERE e.anilist_id = sqlc.arg('anilist_id')::integer
  AND e.event_type = 'status'
  AND (sqlc.narg('event_id')::uuid IS NULL OR e.id = sqlc.narg('event_id')::uuid)
  AND (u.is_public OR e.user_id = sqlc.narg('viewer_id')::uuid)
  AND (
      sqlc.narg('viewer_id')::uuid IS NULL
      OR NOT EXISTS (
          SELECT 1
          FROM user_blocks block
          WHERE (block.blocker_id = sqlc.narg('viewer_id')::uuid AND block.blocked_id = e.user_id)
             OR (block.blocker_id = e.user_id AND block.blocked_id = sqlc.narg('viewer_id')::uuid)
      )
  )
ORDER BY e.created_at DESC, e.id DESC
LIMIT sqlc.arg('page_limit')::integer
OFFSET sqlc.arg('page_offset')::integer;

-- name: CountAnimeActivity :one
SELECT count(*)::bigint AS total
FROM activity_events e
JOIN users u ON u.id = e.user_id
WHERE e.anilist_id = sqlc.arg('anilist_id')::integer
  AND e.event_type = 'status'
  AND (u.is_public OR e.user_id = sqlc.narg('viewer_id')::uuid)
  AND (
      sqlc.narg('viewer_id')::uuid IS NULL
      OR NOT EXISTS (
          SELECT 1
          FROM user_blocks block
          WHERE (block.blocker_id = sqlc.narg('viewer_id')::uuid AND block.blocked_id = e.user_id)
             OR (block.blocker_id = e.user_id AND block.blocked_id = sqlc.narg('viewer_id')::uuid)
      )
  );

-- name: GetActivityEventMeta :one
-- What the reply and like paths need to know about an event: its anime, its
-- owner, whether it is a kind the tab lists, and whether its owner is public.
SELECT
    e.id,
    COALESCE(e.anilist_id, 0)::integer AS anilist_id,
    e.user_id,
    e.event_type,
    owner.is_public AS owner_is_public
FROM activity_events e
JOIN users owner ON owner.id = e.user_id
WHERE e.id = $1;

-- name: AddActivityLike :one
-- Idempotent; same snapshot arithmetic as AddReviewHelpfulVote.
WITH inserted AS (
    INSERT INTO activity_likes (activity_event_id, user_id)
    VALUES (sqlc.arg('event_id')::uuid, sqlc.arg('user_id')::uuid)
    ON CONFLICT (activity_event_id, user_id) DO NOTHING
    RETURNING activity_event_id
)
SELECT (
    (SELECT count(*) FROM activity_likes WHERE activity_event_id = sqlc.arg('event_id')::uuid)
    + (SELECT count(*) FROM inserted)
)::bigint AS like_count;

-- name: RemoveActivityLike :one
WITH deleted AS (
    DELETE FROM activity_likes
    WHERE activity_event_id = sqlc.arg('event_id')::uuid
      AND user_id = sqlc.arg('user_id')::uuid
    RETURNING activity_event_id
)
SELECT greatest(
    (SELECT count(*) FROM activity_likes WHERE activity_event_id = sqlc.arg('event_id')::uuid)
    - (SELECT count(*) FROM deleted),
    0
)::bigint AS like_count;

-- ==================== 谁在追 ====================

-- name: ListAnimeFollowers :many
-- Everyone with the anime on their list, whatever the status, most recent
-- change first.  `since` is when the current status was set: the newest
-- status event that set it, or — for a subscription older than those events
-- (migration 0046) — the row's last update.
SELECT
    u.username,
    u.avatar_url,
    backdrop.cover_image_url AS backdrop_cover_url,
    s.status,
    s.current_episode,
    COALESCE(
        (SELECT max(e.created_at)
         FROM activity_events e
         WHERE e.user_id = s.user_id
           AND e.anilist_id = s.anilist_id
           AND e.event_type = 'status'
           AND e.status = s.status),
        s.updated_at
    )::timestamptz AS since
FROM subscriptions s
JOIN users u ON u.id = s.user_id
LEFT JOIN anime_cache backdrop ON backdrop.anilist_id = u.backdrop_anilist_id
WHERE s.anilist_id = sqlc.arg('anilist_id')::integer
  AND (u.is_public OR s.user_id = sqlc.narg('viewer_id')::uuid)
  AND (
      sqlc.narg('viewer_id')::uuid IS NULL
      OR NOT EXISTS (
          SELECT 1
          FROM user_blocks block
          WHERE (block.blocker_id = sqlc.narg('viewer_id')::uuid AND block.blocked_id = s.user_id)
             OR (block.blocker_id = s.user_id AND block.blocked_id = sqlc.narg('viewer_id')::uuid)
      )
  )
ORDER BY since DESC, u.username ASC
LIMIT sqlc.arg('page_limit')::integer;

-- name: CountAnimeFollowers :one
SELECT
    count(*) FILTER (WHERE s.status = 'watching')::bigint      AS watching,
    count(*) FILTER (WHERE s.status = 'completed')::bigint     AS completed,
    count(*) FILTER (WHERE s.status = 'plan_to_watch')::bigint AS plan_to_watch,
    count(*) FILTER (WHERE s.status = 'dropped')::bigint       AS dropped
FROM subscriptions s
JOIN users u ON u.id = s.user_id
WHERE s.anilist_id = sqlc.arg('anilist_id')::integer
  AND (u.is_public OR s.user_id = sqlc.narg('viewer_id')::uuid)
  AND (
      sqlc.narg('viewer_id')::uuid IS NULL
      OR NOT EXISTS (
          SELECT 1
          FROM user_blocks block
          WHERE (block.blocker_id = sqlc.narg('viewer_id')::uuid AND block.blocked_id = s.user_id)
             OR (block.blocker_id = s.user_id AND block.blocked_id = sqlc.narg('viewer_id')::uuid)
      )
  );

-- name: GetViewerSubscriptionStatus :one
-- The signed-in viewer's own status for the anime; ErrNoRows when they do
-- not follow it.
SELECT s.status
FROM subscriptions s
WHERE s.user_id = $1
  AND s.anilist_id = $2;

-- ==================== Reports ====================

-- name: GetCommunityReportTarget :one
-- The author of a reportable piece of community content, if it is still up
-- and visible to someone other than its author.  A private review is not:
-- only its author can read it, and nobody reports their own words.
SELECT target.user_id, target.anilist_id
FROM (
    SELECT r.user_id, r.anilist_id
    FROM anime_reviews r
    WHERE sqlc.arg('target_type')::text = 'review'
      AND r.id = sqlc.arg('target_id')::uuid
      AND r.deleted_at IS NULL
      AND NOT r.is_private
    UNION ALL
    SELECT t.user_id, t.anilist_id
    FROM anime_threads t
    WHERE sqlc.arg('target_type')::text = 'thread'
      AND t.id = sqlc.arg('target_id')::uuid
      AND t.deleted_at IS NULL
    UNION ALL
    SELECT reply.user_id, reply.anilist_id
    FROM community_replies reply
    WHERE sqlc.arg('target_type')::text = 'reply'
      AND reply.id = sqlc.arg('target_id')::uuid
      AND reply.deleted_at IS NULL
) target
LIMIT 1;

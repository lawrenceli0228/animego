-- edits.sql — reader edits to the person and character pages
-- (internal/edits), their review, and the overlay layer every read of
-- those pages applies (internal/overlay, migration 0047).

-- name: ListEntityOverlays :many
-- The accepted overlays of the given people and characters, by primary
-- key.  An id without one is simply absent from the result.
SELECT kind, entity_id, data
FROM entity_overlays
WHERE (kind = 'person' AND entity_id = ANY(sqlc.arg(person_ids)::int[]))
   OR (kind = 'character' AND entity_id = ANY(sqlc.arg(character_ids)::int[]));

-- name: ListPersonRefs :many
-- What a credit line needs to show a person -- names and a portrait -- for
-- ids an edit names that the page's own credits do not carry: the person a
-- voice row was given to, or a voice an edit added.
--
-- Only people a non-adult title credits are returned (the LATERAL is an
-- inner join), which is also the check that such an id has a page to link
-- to.  The credit columns are the most popular such credit's; the profile
-- (fetched rows only) and Bangumi's Chinese name come first where they
-- exist, as on the person page.
SELECT
    k.id::int AS anilist_id,
    p.name_full,
    p.name_native,
    p.image_large,
    m.name_cn,
    cr.name_full AS credit_full,
    cr.name_native AS credit_native,
    cr.image_url AS credit_image
FROM unnest(sqlc.arg(ids)::int[]) AS k (id)
LEFT JOIN people p ON p.anilist_id = k.id AND p.fetched_at IS NOT NULL
LEFT JOIN bgm_person_map m ON m.anilist_id = k.id
JOIN LATERAL (
    SELECT x.name_full, x.name_native, x.image_url
    FROM (
        SELECT v.name_full, v.name_native, v.image_url, a.popularity
        FROM anime_character_voices v
        JOIN anime_cache a ON a.anilist_id = v.anime_id
        WHERE v.staff_id = k.id AND NOT a.is_adult
        UNION ALL
        SELECT c.voice_actor_en, c.voice_actor_ja, c.voice_actor_image_url, a.popularity
        FROM anime_characters c
        JOIN anime_cache a ON a.anilist_id = c.anime_id
        WHERE c.voice_actor_id = k.id AND NOT a.is_adult
        UNION ALL
        SELECT s.name_en, s.name_ja, s.image_url, a.popularity
        FROM anime_staff s
        JOIN anime_cache a ON a.anilist_id = s.anime_id
        WHERE s.staff_id = k.id AND NOT a.is_adult
    ) x
    ORDER BY x.popularity DESC NULLS LAST
    LIMIT 1
) cr ON true;

-- name: LockEditSubmitter :exec
-- Serialises one person's submissions, so the rate limits below count
-- what is really there: two requests racing past the counts would each
-- see the other's row missing.  Held to the end of the transaction.
SELECT pg_advisory_xact_lock(hashtextextended('edit_submissions:' || sqlc.arg(user_id)::uuid::text, 0));

-- name: CountEditSubmissionsSince :one
SELECT count(*)::int
FROM edit_submissions
WHERE user_id = sqlc.arg(user_id)::uuid
  AND created_at > sqlc.arg(since)::timestamptz;

-- name: CountPendingEditSubmissionsByUser :one
SELECT count(*)::int
FROM edit_submissions
WHERE user_id = sqlc.arg(user_id)::uuid
  AND status = 'pending';

-- name: HasPendingEditSubmission :one
SELECT EXISTS (
    SELECT 1 FROM edit_submissions
    WHERE user_id = sqlc.arg(user_id)::uuid
      AND kind = sqlc.arg(kind)::text
      AND entity_id = sqlc.arg(entity_id)::int
      AND status = 'pending'
)::boolean;

-- name: InsertEditSubmission :one
INSERT INTO edit_submissions (user_id, kind, entity_id, snapshot, source_url, note, item_count)
VALUES (
    sqlc.arg(user_id)::uuid,
    sqlc.arg(kind)::text,
    sqlc.arg(entity_id)::int,
    sqlc.arg(snapshot)::jsonb,
    sqlc.arg(source_url)::text,
    sqlc.narg(note)::text,
    sqlc.arg(item_count)::smallint
)
RETURNING id, created_at;

-- name: InsertEditItem :exec
INSERT INTO edit_items (submission_id, position, field, item_key, old_value, new_value, meta)
VALUES (
    sqlc.arg(submission_id)::uuid,
    sqlc.arg(position)::smallint,
    sqlc.arg(field)::text,
    sqlc.arg(item_key)::text,
    sqlc.arg(old_value)::jsonb,
    sqlc.arg(new_value)::jsonb,
    sqlc.narg(meta)::jsonb
);

-- name: ListPendingEditSubmissions :many
-- The queue, oldest first, with what its rows say about the submitter:
-- the how-many-th submission this is, and how many of theirs had anything
-- accepted.
SELECT
    s.id,
    s.kind,
    s.entity_id,
    s.snapshot,
    s.status,
    s.item_count,
    s.accepted_count,
    s.rejected_count,
    s.created_at,
    s.reviewed_at,
    u.username AS submitter_username,
    (SELECT count(*) FROM edit_submissions x
     WHERE x.user_id = s.user_id AND x.created_at <= s.created_at)::int AS submitter_nth,
    (SELECT count(*) FROM edit_submissions x
     WHERE x.user_id = s.user_id AND x.accepted_count > 0)::int AS submitter_accepted,
    EXISTS (SELECT 1 FROM edit_items i
            WHERE i.submission_id = s.id AND i.field = 'image')::boolean AS has_image
FROM edit_submissions s
JOIN users u ON u.id = s.user_id
WHERE s.status = 'pending'
  AND (sqlc.narg(kind)::text IS NULL OR s.kind = sqlc.narg(kind)::text)
ORDER BY s.created_at, s.id
LIMIT sqlc.arg(page_limit)::int OFFSET sqlc.arg(page_offset)::int;

-- name: ListReviewedEditSubmissions :many
-- The reviewed list, newest review first; the same columns as the queue.
SELECT
    s.id,
    s.kind,
    s.entity_id,
    s.snapshot,
    s.status,
    s.item_count,
    s.accepted_count,
    s.rejected_count,
    s.created_at,
    s.reviewed_at,
    u.username AS submitter_username,
    (SELECT count(*) FROM edit_submissions x
     WHERE x.user_id = s.user_id AND x.created_at <= s.created_at)::int AS submitter_nth,
    (SELECT count(*) FROM edit_submissions x
     WHERE x.user_id = s.user_id AND x.accepted_count > 0)::int AS submitter_accepted,
    EXISTS (SELECT 1 FROM edit_items i
            WHERE i.submission_id = s.id AND i.field = 'image')::boolean AS has_image
FROM edit_submissions s
JOIN users u ON u.id = s.user_id
WHERE s.status = 'reviewed'
  AND (sqlc.narg(kind)::text IS NULL OR s.kind = sqlc.narg(kind)::text)
ORDER BY s.reviewed_at DESC, s.id DESC
LIMIT sqlc.arg(page_limit)::int OFFSET sqlc.arg(page_offset)::int;

-- name: CountPendingEditSubmissions :one
SELECT count(*)::int FROM edit_submissions WHERE status = 'pending';

-- name: GetEditSubmission :one
SELECT
    s.id,
    s.user_id,
    s.kind,
    s.entity_id,
    s.snapshot,
    s.source_url,
    s.note,
    s.status,
    s.item_count,
    s.accepted_count,
    s.rejected_count,
    s.created_at,
    s.reviewed_at,
    u.username AS submitter_username,
    r.username AS reviewer_username,
    (SELECT count(*) FROM edit_submissions x
     WHERE x.user_id = s.user_id AND x.created_at <= s.created_at)::int AS submitter_nth,
    (SELECT count(*) FROM edit_submissions x
     WHERE x.user_id = s.user_id AND x.accepted_count > 0)::int AS submitter_accepted
FROM edit_submissions s
JOIN users u ON u.id = s.user_id
LEFT JOIN users r ON r.id = s.reviewed_by
WHERE s.id = sqlc.arg(id)::uuid;

-- name: LockEditSubmission :one
-- The review holds the submission row for its whole transaction: a second
-- admin reviewing the same submission waits, then finds it reviewed.
SELECT id, user_id, kind, entity_id, status
FROM edit_submissions
WHERE id = sqlc.arg(id)::uuid
FOR UPDATE;

-- name: ListEditItems :many
SELECT id, position, field, item_key, old_value, new_value, meta, status, reject_note
FROM edit_items
WHERE submission_id = sqlc.arg(submission_id)::uuid
ORDER BY position;

-- name: DecideEditItem :execrows
UPDATE edit_items
SET status = sqlc.arg(status)::text,
    reject_note = sqlc.narg(reject_note)::text
WHERE id = sqlc.arg(id)::uuid
  AND submission_id = sqlc.arg(submission_id)::uuid
  AND status = 'pending';

-- name: MarkEditSubmissionReviewed :exec
UPDATE edit_submissions
SET status = 'reviewed',
    accepted_count = sqlc.arg(accepted_count)::smallint,
    rejected_count = sqlc.arg(rejected_count)::smallint,
    reviewed_by = sqlc.arg(reviewed_by)::uuid,
    reviewed_at = now()
WHERE id = sqlc.arg(id)::uuid;

-- name: EnsureEntityOverlay :exec
-- So LockEntityOverlay has a row to lock even for a first edit.
INSERT INTO entity_overlays (kind, entity_id)
VALUES (sqlc.arg(kind)::text, sqlc.arg(entity_id)::int)
ON CONFLICT (kind, entity_id) DO NOTHING;

-- name: LockEntityOverlay :one
-- Read-modify-write of one overlay: two reviews of the same page accept
-- one after the other, and neither loses the other's fields.
SELECT data
FROM entity_overlays
WHERE kind = sqlc.arg(kind)::text AND entity_id = sqlc.arg(entity_id)::int
FOR UPDATE;

-- name: SaveEntityOverlay :exec
UPDATE entity_overlays
SET data = sqlc.arg(data)::jsonb,
    updated_at = now(),
    updated_by = sqlc.narg(updated_by)::uuid
WHERE kind = sqlc.arg(kind)::text AND entity_id = sqlc.arg(entity_id)::int;

-- name: InsertEditReviewNotification :exec
-- The submitter learns the outcome through the inbox.  One per
-- submission (the dedupe key), and never to oneself: an admin reviewing
-- their own submission is not notified (notifications_not_self_chk).
INSERT INTO notifications (user_id, actor_id, notification_type, edit_submission_id, dedupe_key)
VALUES (
    sqlc.arg(user_id)::uuid,
    sqlc.arg(actor_id)::uuid,
    'edit_review',
    sqlc.arg(submission_id)::uuid,
    'edit_review:' || sqlc.arg(submission_id)::uuid::text
)
ON CONFLICT (user_id, dedupe_key) DO NOTHING;

-- name: ListEditReviewNotifications :many
-- What an edit_review notification reports: the page, how it was decided,
-- and the notes on the parts that were not accepted, in item order.
SELECT
    n.id AS notification_id,
    s.kind,
    s.entity_id,
    s.snapshot,
    s.accepted_count,
    s.rejected_count,
    COALESCE(
        (SELECT array_agg(i.reject_note ORDER BY i.position)
         FROM edit_items i
         WHERE i.submission_id = s.id AND i.status = 'rejected'),
        '{}'
    )::text[] AS reject_notes
FROM notifications n
JOIN edit_submissions s ON s.id = n.edit_submission_id
WHERE n.id = ANY(sqlc.arg(notification_ids)::uuid[])
  AND n.user_id = sqlc.arg(user_id)::uuid;

-- name: ListAnimeIDsCrediting :many
-- Every title whose credits name the person or character: the detail
-- responses that carry their name and image, which a review drops from
-- the detail cache.
SELECT DISTINCT x.anime_id
FROM (
    SELECT c.anime_id FROM anime_characters c
    WHERE sqlc.arg(kind)::text = 'character' AND c.character_id = sqlc.arg(entity_id)::int
    UNION ALL
    SELECT c.anime_id FROM anime_characters c
    WHERE sqlc.arg(kind)::text = 'person' AND c.voice_actor_id = sqlc.arg(entity_id)::int
    UNION ALL
    SELECT s.anime_id FROM anime_staff s
    WHERE sqlc.arg(kind)::text = 'person' AND s.staff_id = sqlc.arg(entity_id)::int
) x;

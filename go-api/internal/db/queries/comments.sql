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
    id,
    anilist_id,
    episode,
    user_id,
    username,
    content,
    parent_id,
    reply_to_username,
    created_at,
    updated_at
FROM episode_comments
WHERE anilist_id = $1
  AND episode = $2
ORDER BY created_at ASC
LIMIT 500;

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
    parent_id,
    reply_to_username
) VALUES ($1, $2, $3, $4, $5, $6, $7)
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
    updated_at;

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

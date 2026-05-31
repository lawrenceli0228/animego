-- Queries against danmakus + episode_windows (P2.5).
--
-- HTTP surface is read-only for danmaku — writes go through socket.io
-- (P2.8).  One endpoint:
--
--   GET /api/danmaku/:anilistId/:episode → ListDanmakuRecent + GetEpisodeWindow
--
-- The endpoint emits a special envelope:  `{ data: [...], liveEndsAt }`
-- (liveEndsAt is a SIBLING of data, not nested inside it).  Express's
-- controller marshalled the two via res.json({data, liveEndsAt}) — we
-- mirror byte-for-byte via a custom envelope helper at the handler layer.

-- name: ListDanmakuRecent :many
-- 500-row cap matches Express ($limit 500 + reverse to chronological).
-- We return DESC then handler reverses in memory — keeps the LIMIT cap
-- selecting the *latest* 500 instead of the oldest.  Chronological
-- order is what the player expects so the bullet-screen overlay can
-- replay danmakus in send order.
SELECT
    id,
    username,
    content,
    created_at
FROM danmakus
WHERE anilist_id = $1
  AND episode = $2
ORDER BY created_at DESC
LIMIT 500;

-- name: GetEpisodeWindow :one
-- Returns the liveEndsAt timestamp for this episode if a live window
-- exists, else pgx.ErrNoRows (handler maps → null in the envelope).
SELECT
    anilist_id,
    episode,
    live_ends_at
FROM episode_windows
WHERE anilist_id = $1
  AND episode = $2;

-- image_mirror.sql — the image warm job (queue/image_warm.go): which
-- AniList images to ask nginx to store next, and what each answer was.
--
-- The referenced set is the image_refs view and only that (migration 0049
-- says why).  image_manager holds one row per URL the job has had an answer
-- for; a URL with no row has never been asked about.

-- name: ImageWarmBlocked :one
-- Whether a pass must not run: AniList answered 429 and the time it asked
-- us to wait (next_attempt_at) has not passed yet.  Checked before
-- anything else a pass does, so a throttle window stops every pass that
-- starts inside it, not just the one that met the 429.
SELECT EXISTS (
    SELECT 1
    FROM image_manager
    WHERE status = 'throttled'
      AND next_attempt_at > now()
)::boolean AS blocked;

-- name: ListImageWarmBatch :many
-- The URLs one pass asks for, at most row_limit, in three tiers:
--
--   1. never asked about (no row), by URL;
--   2. due again: a 'missing' or 'throttled' row whose next_attempt_at has
--      passed, longest due first;
--   3. the monthly re-check: a 'warmed' row warmed longer ago than
--      recheck_after, oldest first.  nginx answers it with a conditional
--      request to AniList, so an unchanged image costs AniList no body.
--
-- Driven from image_refs, so a URL nothing references any more is never
-- asked for again, whatever its row says.  The cost is the view's: it reads
-- every referencing column once.  Each referenced URL then looks its row up
-- through the primary key.
SELECT r.url::text AS url
FROM image_refs r
LEFT JOIN image_manager m ON m.url = r.url
WHERE m.url IS NULL
   OR (m.status IN ('missing', 'throttled') AND m.next_attempt_at <= now())
   OR (m.status = 'warmed' AND m.warmed_at < now() - sqlc.arg(recheck_after)::interval)
ORDER BY
    CASE WHEN m.url IS NULL THEN 1 WHEN m.status = 'warmed' THEN 3 ELSE 2 END,
    CASE WHEN m.status = 'warmed' THEN m.warmed_at ELSE m.next_attempt_at END,
    r.url
LIMIT sqlc.arg(row_limit)::int;

-- name: MarkImageWarmed :exec
-- nginx answered 200: it holds the original.  The row is due for a
-- re-check once warmed_at is older than the job's re-check interval.
INSERT INTO image_manager (url, status, warmed_at, next_attempt_at, attempts, last_http_status)
VALUES (sqlc.arg(url), 'warmed', now(), NULL, 1, 200)
ON CONFLICT (url) DO UPDATE
SET status           = 'warmed',
    warmed_at        = now(),
    next_attempt_at  = NULL,
    attempts         = image_manager.attempts + 1,
    last_http_status = 200,
    updated_at       = now();

-- name: MarkImageMissing :exec
-- AniList has no such file (a 4xx other than 401, 403 and 429, which the job
-- treats as being refused or throttled), or the path is outside
-- the ones nginx will store, in which case no request was sent and
-- last_http_status is NULL.  Asked again after retry_after.  warmed_at is
-- left as it was: when the image was last held is still true.
INSERT INTO image_manager (url, status, next_attempt_at, attempts, last_http_status)
VALUES (sqlc.arg(url), 'missing', now() + sqlc.arg(retry_after)::interval, 1, sqlc.narg(last_http_status)::int)
ON CONFLICT (url) DO UPDATE
SET status           = 'missing',
    next_attempt_at  = EXCLUDED.next_attempt_at,
    attempts         = image_manager.attempts + 1,
    last_http_status = EXCLUDED.last_http_status,
    updated_at       = now();

-- name: MarkImageThrottled :exec
-- AniList answered 429.  next_attempt_at is when it asked us to come back,
-- and until then ImageWarmBlocked stops every pass.  The URL itself is due
-- again from that time, as a retry.
INSERT INTO image_manager (url, status, next_attempt_at, attempts, last_http_status)
VALUES (sqlc.arg(url), 'throttled', now() + sqlc.arg(retry_after)::interval, 1, 429)
ON CONFLICT (url) DO UPDATE
SET status           = 'throttled',
    next_attempt_at  = EXCLUDED.next_attempt_at,
    attempts         = image_manager.attempts + 1,
    last_http_status = 429,
    updated_at       = now();

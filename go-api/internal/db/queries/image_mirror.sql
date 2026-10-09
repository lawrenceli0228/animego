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
-- The URLs one pass asks for, at most row_limit, in four tiers:
--
--   1. never asked about (no row), by URL;
--   2. due again: a 'missing' or 'throttled' row whose next_attempt_at has
--      passed, longest due first;
--   3. the monthly re-check of a URL whose file name carries no content
--      hash: a 'warmed' row warmed longer ago than recheck_after, oldest
--      first.  nginx answers it with a conditional request to AniList, so an
--      unchanged image costs AniList no body;
--   4. due again after failing: a 'failed' row whose next_attempt_at has
--      passed, longest due first.
--
-- Only an unhashed URL is re-checked.  AniList names most files with a
-- content hash, a dash and twelve letters and digits before the extension
-- (bx154587-qQTzQnEJJ3oB.jpg), and the bytes behind such a name never
-- change: when AniList changes an image it gives it a new URL, which reaches
-- us through the database as a URL never asked about.  Asking for a hashed
-- original again would only spend AniList requests, which this job exists
-- to keep few.  The test is narrow on purpose: a name that only nearly
-- matches -- eleven or thirteen characters, or a character that is not a
-- letter or digit -- counts as unhashed and is re-checked, so if AniList
-- changes how it names files the job re-checks too much, never too little.
-- (nginx still revalidates an expired hashed original when a reader asks for
-- it, and serves the stored copy while AniList is in trouble.  That needs
-- nothing from this job.)
--
-- Failures come last.  Three in a row stop a pass, and a URL that fails
-- every time is asked again on its own backoff (MarkImageFailed); at the end
-- of the batch a run of them cuts off only the failures behind it, never a
-- new image, a retry or a re-check.
--
-- Driven from image_refs, so a URL nothing references any more is never
-- asked for again, whatever its row says.  The cost is the view's: it reads
-- every referencing column once.  Each referenced URL then looks its row up
-- through the primary key.
SELECT r.url::text AS url
FROM image_refs r
LEFT JOIN image_manager m ON m.url = r.url
WHERE m.url IS NULL
   OR (m.status IN ('missing', 'throttled', 'failed') AND m.next_attempt_at <= now())
   OR (m.status = 'warmed' AND m.warmed_at < now() - sqlc.arg(recheck_after)::interval
       AND r.url !~ '-[A-Za-z0-9]{12}\.(jpe?g|png|gif|webp)$')
ORDER BY
    CASE
        WHEN m.url IS NULL THEN 1
        WHEN m.status IN ('missing', 'throttled') THEN 2
        WHEN m.status = 'warmed' THEN 3
        WHEN m.status = 'failed' THEN 4
    END,
    CASE WHEN m.status = 'warmed' THEN m.warmed_at ELSE m.next_attempt_at END,
    r.url
LIMIT sqlc.arg(row_limit)::int;

-- name: MarkImageWarmed :exec
-- nginx answered 200: it holds the original.  If the URL carries no content
-- hash, the row is due for a re-check once warmed_at is older than the job's
-- re-check interval.  Like every answer but a failure, it ends a run of
-- failures, so failures goes back to 0.
INSERT INTO image_manager (url, status, warmed_at, next_attempt_at, attempts, last_http_status)
VALUES (sqlc.arg(url), 'warmed', now(), NULL, 1, 200)
ON CONFLICT (url) DO UPDATE
SET status           = 'warmed',
    warmed_at        = now(),
    next_attempt_at  = NULL,
    attempts         = image_manager.attempts + 1,
    failures         = 0,
    last_http_status = 200,
    updated_at       = now();

-- name: MarkImageMissing :exec
-- AniList has no such file (a 4xx other than 401, 403 and 429, which the job
-- treats as being refused or throttled), or the path is outside
-- the ones nginx will store, in which case no request was sent and
-- last_http_status is NULL.  Asked again after retry_after.  warmed_at is
-- left as it was: when the image was last held is still true.  failures
-- goes back to 0, as it does for every answer but a failure.
INSERT INTO image_manager (url, status, next_attempt_at, attempts, last_http_status)
VALUES (sqlc.arg(url), 'missing', now() + sqlc.arg(retry_after)::interval, 1, sqlc.narg(last_http_status)::int)
ON CONFLICT (url) DO UPDATE
SET status           = 'missing',
    next_attempt_at  = EXCLUDED.next_attempt_at,
    attempts         = image_manager.attempts + 1,
    failures         = 0,
    last_http_status = EXCLUDED.last_http_status,
    updated_at       = now();

-- name: MarkImageThrottled :exec
-- AniList answered 429.  next_attempt_at is when it asked us to come back,
-- and until then ImageWarmBlocked stops every pass.  The URL itself is due
-- again from that time, as a retry.  failures goes back to 0, as it does
-- for every answer but a failure: being told to wait is not the URL failing.
INSERT INTO image_manager (url, status, next_attempt_at, attempts, last_http_status)
VALUES (sqlc.arg(url), 'throttled', now() + sqlc.arg(retry_after)::interval, 1, 429)
ON CONFLICT (url) DO UPDATE
SET status           = 'throttled',
    next_attempt_at  = EXCLUDED.next_attempt_at,
    attempts         = image_manager.attempts + 1,
    failures         = 0,
    last_http_status = 429,
    updated_at       = now();

-- name: MarkImageFailed :exec
-- The request failed: a 5xx, a timeout, a 401 or 403, a redirect, or a 200
-- whose body broke off.  last_http_status is the status when the status was
-- the failure, and NULL when it was not: a timeout has none, and a 200 cut
-- short failed in its body.
--
-- Recorded so that a URL that fails every time stops heading the batch: it
-- leaves the never-asked tier, and the batch reaches it only once it is due
-- again, last of all.  The wait is an hour, doubled for each failure in a
-- row before this one, and never more than 30 days: 1h, 2h, 4h and so on.  A
-- URL that keeps failing is asked less and less often, and an AniList that
-- fails for a day costs each URL a handful of requests rather than one a
-- pass.  The exponent stops at 10, where the doubling is already past 30
-- days: unbounded, enough failures in a row would overflow the interval
-- before least() could cap it.
--
-- warmed_at is left as it was: a re-check that fails does not take away the
-- original nginx stored, and when it was stored is still true.
INSERT INTO image_manager (url, status, next_attempt_at, attempts, failures, last_http_status)
VALUES (sqlc.arg(url), 'failed', now() + interval '1 hour', 1, 1, sqlc.narg(last_http_status)::int)
ON CONFLICT (url) DO UPDATE
SET status           = 'failed',
    next_attempt_at  = now() + least(interval '1 hour' * power(2, least(image_manager.failures, 10)),
                                     interval '30 days'),
    attempts         = image_manager.attempts + 1,
    failures         = image_manager.failures + 1,
    last_http_status = EXCLUDED.last_http_status,
    updated_at       = now();

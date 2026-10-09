-- 0049: what the image warm job (queue/image_warm.go) reads and writes.
--
-- The site's images are AniList CDN URLs held in twelve columns of eight
-- tables.  nginx keeps a copy of each original, and only the warm job fills
-- that copy: it asks an internal nginx endpoint for every image the
-- database references, one path at a time, and nginx stores what AniList
-- returns.  This file is the job's two halves on the database side.
--
-- image_refs is the one definition of "an image the database references":
-- every distinct AniList CDN URL in those twelve columns, and nothing else.
-- The job reads only this view.  A column missing from it is an image that
-- is never stored and keeps depending on AniList, with no error anywhere,
-- so a test (queue/image_warm_pg_test.go) fails when a table has a text
-- column whose name says image, cover or banner and the view does not read
-- it.  A migration that adds such a column adds it here in the same file;
-- CREATE OR REPLACE VIEW keeps the view's one column.
--
-- One consequence of the view, stated so it is not discovered mid-deploy:
-- PostgreSQL refuses to drop a column a view reads or change its type.  A
-- migration that does either to one of these twelve columns drops the view
-- first and creates it again after.
--
-- image_manager has one row per URL the job has had an answer for, and what
-- the answer was.  It holds no image and no list of references (the view is
-- that):
--
--   status            'warmed'    nginx holds the original, since
--                                 warmed_at.  If the file name carries no
--                                 content hash, the URL is asked again once
--                                 warmed_at is older than the job's
--                                 re-check interval, and nginx answers with
--                                 a conditional request to AniList.  A
--                                 hashed one is not asked again: its bytes
--                                 never change.
--                     'missing'   AniList has no such file, or the path is
--                                 outside the ones nginx will store.  Asked
--                                 again at next_attempt_at.
--                     'throttled' AniList asked us to slow down.  No pass
--                                 runs until next_attempt_at.
--                     'failed'    the last answer was a failure: a 5xx, a
--                                 timeout, a 401 or 403, a redirect, or a
--                                 200 whose body broke off.  Asked again at
--                                 next_attempt_at, which moves further off
--                                 with each failure in a row.
--   attempts          how many answers the job has recorded for the URL.
--   failures          how many answers in a row, ending with the last, were
--                     failures: 0 unless the row is 'failed', since any
--                     other answer sets it back to 0.  The wait after a
--                     failure is an hour, doubled for each failure in a row
--                     before it, and 30 days at most.
--   last_http_status  the status of the last answer.  NULL on a 'missing'
--                     row whose path was refused before a request was
--                     sent, and on a 'failed' row whose failure was not a
--                     status: a timeout, or a 200 whose body broke off.
--
-- A URL with no row has never been asked about.  A request that got no
-- answer about the URL at all -- no connection to nginx, or a pass
-- cancelled -- is not recorded, so a deploy leaves every URL due exactly as
-- it was.  A failure is recorded, and must be: unrecorded, a URL that fails
-- every time would stay among the never asked, which head every batch, and
-- three such URLs sorting together would stop every pass before it reached
-- anything behind them.
--
-- The first CHECKs keep every row reachable by the job's batch query: a
-- 'warmed' row with no warmed_at would never be re-checked, and a row
-- waiting on a NULL next_attempt_at, a 'failed' one included, would wait
-- forever.  The last holds failures to the status: a count left over from a
-- run of failures that has ended would stretch the wait after the next one.
--
-- The batch.  ListImageWarmBatch takes, in this order: URLs never asked
-- about; 'missing' and 'throttled' rows that are due; 'warmed' rows of
-- unhashed URLs due a re-check; 'failed' rows that are due.  Failures come
-- last, so a run of them, which stops the pass, cuts off only the failures
-- behind it.
--
-- Indexes.  The batch query (ListImageWarmBatch) reaches this table only
-- by looking each referenced URL up, which is what the primary key serves.
-- The second index serves the check that opens every pass
-- (ImageWarmBlocked): a range of one status by next_attempt_at, read from
-- the index alone.
--
-- Locks.  A new table, its index, and a view.  Creating the view reads the
-- definitions of the eight tables it selects from, which takes ACCESS SHARE
-- on each -- the lock every SELECT takes -- so it waits only behind DDL on
-- one of them, and holds nothing anyone else wants meanwhile.
CREATE TABLE image_manager (
    url              text PRIMARY KEY,
    status           text NOT NULL,
    warmed_at        timestamptz,
    next_attempt_at  timestamptz,
    attempts         integer NOT NULL DEFAULT 0,
    failures         integer NOT NULL DEFAULT 0,
    last_http_status integer,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT image_manager_status_chk
        CHECK (status IN ('warmed', 'missing', 'throttled', 'failed')),
    CONSTRAINT image_manager_warmed_at_chk
        CHECK (status <> 'warmed' OR warmed_at IS NOT NULL),
    CONSTRAINT image_manager_next_attempt_at_chk
        CHECK (status = 'warmed' OR next_attempt_at IS NOT NULL),
    CONSTRAINT image_manager_failures_chk
        CHECK ((status = 'failed' AND failures > 0) OR (status <> 'failed' AND failures = 0))
);

CREATE INDEX image_manager_status_next_attempt_idx ON image_manager (status, next_attempt_at);

CREATE VIEW image_refs AS
SELECT DISTINCT refs.url
FROM (
              SELECT cover_image_url AS url FROM anime_cache
    UNION ALL SELECT banner_image_url      FROM anime_cache
    UNION ALL SELECT cover_image_url       FROM anime_recommendations
    UNION ALL SELECT cover_image_url       FROM anime_relations
    UNION ALL SELECT image_url             FROM anime_characters
    UNION ALL SELECT voice_actor_image_url FROM anime_characters
    UNION ALL SELECT image_url             FROM anime_character_voices
    UNION ALL SELECT image_url             FROM anime_staff
    UNION ALL SELECT image_large           FROM characters
    UNION ALL SELECT image_medium          FROM characters
    UNION ALL SELECT image_large           FROM people
    UNION ALL SELECT image_medium          FROM people
) AS refs
-- Leaves out NULL, the empty string, and every URL not on AniList's CDN.
WHERE refs.url LIKE 'https://s4.anilist.co/file/anilistcdn/%';

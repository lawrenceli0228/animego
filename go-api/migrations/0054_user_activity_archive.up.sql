-- go-api/migrations/0054_user_activity_archive.up.sql
-- Deleting an account must not rewrite the activity history it was part of.
--
-- WHAT WENT WRONG WITHOUT THIS.  user_activity_daily cascades on users.id
-- (0025), and the admin activity panel counts signups straight out of
-- `users`.  So deleting one account silently subtracted that person from
-- every day they had ever been active and from the signup bar of the day they
-- registered: yesterday's DAU, last month's signups and every retention cohort
-- they belonged to all got smaller, after the fact, with nothing on screen to
-- say so.  The delete button sits on the same page as the charts it was
-- editing.
--
-- WHAT THIS KEEPS, AND WHAT IT DOES NOT.  When an account is deleted, the
-- delete transaction (admin.UserStore.ArchiveAndDeleteUser) copies the two
-- facts the activity panel is built from into the tables below, under a fresh
-- random archive_id:
--
--   archived_users                 the signup instant
--   archived_user_activity_daily   one row per day the person was active
--
-- Nothing that identifies the person survives: no user id, username, email,
-- or anything joinable back to them.  archive_id is generated here, never
-- derived from users.id.  What survives is exactly what a count needs -- that
-- somebody signed up at this instant and was here on these days -- so the
-- history stays the same size and the person is gone.
--
-- READ THE VIEWS, NOT THE TABLES.  activity_people and activity_days are the
-- union of the live tables and the archive.  Every statistic that counts
-- people over time (DAU/WAU/MAU, the daily trend, signups per day, depth,
-- retention cohorts, instrumentation start) reads these two views.  Anything
-- that lists ACCOUNTS (the user table, a user's detail page) reads `users` and
-- `user_activity_daily` directly, because a deleted account is not an account.
--
-- person_id in the views is a users.id for a live account and an archive_id
-- for an archived one.  Both are random v4 uuids from different generators,
-- so a collision is not a practical concern, and nothing joins person_id back
-- to `users` except through the live half of the union.

-- Same reasoning as 0025: fail fast rather than queue behind a long
-- transaction.  Nothing here takes a lock on `users`.
SET lock_timeout = '3s';

CREATE TABLE archived_users (
    archive_id  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The deleted account's users.created_at, unchanged.  Signup days and
    -- retention cohorts are bucketed from this exactly as they are from
    -- users.created_at.
    created_at  timestamptz NOT NULL,
    -- When the account was deleted.  Read by nothing on the panel; it is here
    -- so an operator can tell a burst of archives apart from a slow trickle.
    archived_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_archived_users_created ON archived_users (created_at);

-- Column for column the shape of user_activity_daily (0025), including both of
-- its CHECK constraints and its key order, so the union in activity_days is a
-- straight copy and a row means the same thing on either side of it.
-- request_count = 0 still marks a row reconstructed by 0026's backfill: the
-- copy keeps the value, so instrumented_since derived over the union stays
-- exact even when the account that produced the earliest live row is deleted.
CREATE TABLE archived_user_activity_daily (
    archive_id    uuid        NOT NULL REFERENCES archived_users (archive_id) ON DELETE CASCADE,
    activity_date date        NOT NULL,
    first_seen_at timestamptz NOT NULL,
    last_seen_at  timestamptz NOT NULL,
    request_count bigint      NOT NULL DEFAULT 0,
    login_count   bigint      NOT NULL DEFAULT 0,
    PRIMARY KEY (activity_date, archive_id),
    CONSTRAINT archived_user_activity_daily_counts_chk CHECK (
        request_count >= 0 AND login_count >= 0
    ),
    CONSTRAINT archived_user_activity_daily_window_chk CHECK (last_seen_at >= first_seen_at)
);

-- The per-person order, for the same reads idx_user_activity_daily_user
-- serves on the live table (a cohort member's first day back).
CREATE INDEX idx_archived_user_activity_daily_person
    ON archived_user_activity_daily (archive_id, activity_date DESC);

-- Everybody who ever signed up and is counted: live accounts plus deleted
-- ones.  created_at is the signup instant on both sides.
CREATE VIEW activity_people AS
    SELECT id AS person_id, created_at
    FROM users
    UNION ALL
    SELECT archive_id AS person_id, created_at
    FROM archived_users;

-- Every recorded day of every person in activity_people.
CREATE VIEW activity_days AS
    SELECT user_id AS person_id, activity_date, first_seen_at, last_seen_at,
           request_count, login_count
    FROM user_activity_daily
    UNION ALL
    SELECT archive_id AS person_id, activity_date, first_seen_at, last_seen_at,
           request_count, login_count
    FROM archived_user_activity_daily;

-- The archive keeps the live table's 400-day horizon (0025), on its own
-- schedule a quarter of an hour after that prune so the two never contend for
-- the pg_cron worker.  A signup row is removed only once it is past the
-- horizon AND has no activity left: an account registered 500 days ago and
-- deleted yesterday still owns this year's activity rows.
SELECT cron.schedule(
    'user-activity-archive-prune',
    '15 5 * * *',
    $job$
DELETE FROM archived_user_activity_daily
WHERE activity_date < ((now() AT TIME ZONE 'Asia/Shanghai')::date - 400);
DELETE FROM archived_users a
WHERE a.created_at < now() - interval '400 days'
  AND NOT EXISTS (
      SELECT 1 FROM archived_user_activity_daily d WHERE d.archive_id = a.archive_id
  );
$job$
);

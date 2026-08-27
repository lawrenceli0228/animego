-- go-api/migrations/0026_user_activity_backfill.up.sql
-- Seed user_activity_daily from the presence that other tables happen to have
-- witnessed, so the dashboard opens with a history instead of a blank chart.
--
-- Separate file from 0025 on purpose.  0025 is DDL and reversible; this is
-- DML over every user-owned table in the schema, and the two have no reason to
-- share a transaction, a rollback, or a review.
--
--
-- ⚠️ THE ONE THING TO UNDERSTAND BEFORE READING ANY CHART BUILT ON THIS.
--
-- Everything inserted here is an INTERACTION day: a day on which the account
-- left a durable trace somewhere -- a comment, a danmaku, a follow, a
-- subscription, the signup itself.  That is a strict subset of the days the
-- account was actually present, and a small one.  A reader who browsed the
-- catalogue every evening for a month without commenting produced exactly one
-- row here (their signup) and thirty rows going forward.
--
-- So the series has a seam.  Left of the day instrumentation began it counts
-- interactions; right of it, visits.  Plotted continuously with no divider,
-- the changeover looks like the product suddenly took off, and it will be read
-- that way -- by us, six months from now, having forgotten.  The seam is
-- therefore made findable in the data rather than in a comment: every row
-- below carries request_count = 0, the live recorder always increments it
-- above zero, so
--
--     SELECT min(activity_date) FROM user_activity_daily WHERE request_count > 0
--
-- is the exact instrumentation date, and GET /api/admin/activity returns it as
-- `instrumentedSince` so the UI can draw the line.  Do not "tidy up" the zero.
--
--
-- WHAT IS DELIBERATELY NOT A SOURCE.
--
--   episode_watches (0024).  Its watched_at is documented there as "the time
--   the mark was made", and 0024's own backfill stamped every pre-existing
--   mark with the migration's transaction timestamp -- one instant, shared by
--   thousands of rows across hundreds of accounts.  Feeding that in would
--   manufacture a single day on which nearly the entire user base was active,
--   which is both false and exactly the shape of a metric somebody
--   screenshots.  The genuinely-new marks written since are real, but nothing
--   in the row distinguishes them from the burst, so the whole table is out.
--   Marks made from here on are captured anyway: writing one is an
--   authenticated API call, which the recorder sees.
--
--   subscriptions.updated_at.  It is overwritten on every progress bump, so it
--   records only the most recent touch, not a day the account was present.
--   Using it would put one row on today for every subscription ever updated.
--   created_at, immediately below, is safe for the same reason updated_at is
--   not: it never moves.
--
--   notifications.  Received, not performed.  A notification proves somebody
--   else was active.
--
--   activity_events watch_progress rows older than 90 days.  Not excluded
--   here -- they are simply already gone, pruned by 0021's schedule.  Named
--   so the thin tail in older months reads as a known retention boundary
--   rather than as a bug in this query.

INSERT INTO user_activity_daily (
    user_id,
    activity_date,
    first_seen_at,
    last_seen_at,
    request_count,
    page_view_count,
    playback_count,
    login_count
)
SELECT
    evidence.user_id,
    -- +08, matching 0025's day boundary and internal/activity's writer.
    -- Casting each timestamp individually (rather than grouping on a UTC date
    -- and shifting afterwards) is what keeps a 01:00 CST action on its own
    -- evening instead of the previous one.
    (evidence.happened_at AT TIME ZONE 'Asia/Shanghai')::date AS activity_date,
    min(evidence.happened_at) AS first_seen_at,
    max(evidence.happened_at) AS last_seen_at,
    -- The seam marker.  See the header.
    0 AS request_count,
    0 AS page_view_count,
    0 AS playback_count,
    0 AS login_count
FROM (
    -- The signup day.  Included first and unconditionally, because it is the
    -- one day every account is known to have been present, and because
    -- retention needs it: a cohort whose day 0 is missing from this table
    -- would compute "returned on day 1" against a denominator assembled from
    -- users rather than from activity, and the two would quietly disagree.
    SELECT id AS user_id, created_at AS happened_at FROM users

    UNION ALL
    SELECT user_id, created_at FROM episode_comments

    UNION ALL
    SELECT user_id, created_at FROM danmakus

    UNION ALL
    -- The follower acted; the followee did not.  followee_id is not a
    -- presence signal and is not read here.
    SELECT follower_id, created_at FROM follows

    UNION ALL
    SELECT user_id, created_at FROM subscriptions

    UNION ALL
    -- Overlaps comments and follows by construction (0018 writes an event
    -- alongside each), which costs nothing: the GROUP BY collapses duplicate
    -- evidence for the same person on the same day into one row.  It is
    -- included for the watch_progress rows the other sources cannot see.
    SELECT user_id, created_at FROM activity_events

    UNION ALL
    SELECT user_id, created_at FROM comment_reactions

    UNION ALL
    SELECT blocker_id, created_at FROM user_blocks

    UNION ALL
    SELECT reporter_id, created_at FROM reports
) AS evidence
GROUP BY evidence.user_id, (evidence.happened_at AT TIME ZONE 'Asia/Shanghai')::date

-- Idempotent, and non-destructive against live traffic.
--
-- DO NOTHING would be wrong here rather than merely weaker: if this runs on a
-- container that has already been serving for a few minutes, today's row
-- exists with a real request_count, and DO NOTHING would drop the historical
-- first_seen_at for that day on the floor.  LEAST/GREATEST widens the window
-- to cover both sources and leaves every counter the recorder owns untouched,
-- so a re-run converges instead of either failing or losing data.
ON CONFLICT (activity_date, user_id) DO UPDATE
SET first_seen_at = LEAST(user_activity_daily.first_seen_at, EXCLUDED.first_seen_at),
    last_seen_at  = GREATEST(user_activity_daily.last_seen_at, EXCLUDED.last_seen_at);

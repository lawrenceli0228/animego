-- Queries over the migration-0025 activity rollup: the five reads behind
-- GET /api/admin/activity, plus the per-user batch the admin user table needs.
--
-- THE DAY BOUNDARY IS DEFINED ONCE, HERE, AND IT IS +08.
-- Every query in this file buckets on `AT TIME ZONE 'Asia/Shanghai'` and every
-- one of them derives "today" the same way.  0025's header explains why the
-- boundary is not UTC; what matters for this file is that the expression is
-- identical in every place it appears.  A single query that reached for `current_date`
-- instead would silently measure a different day than the rest of the page for
-- the eight hours between the two midnights -- which is most of a Chinese
-- evening, i.e. exactly when the numbers are worth looking at.
--
-- Conventions follow admin.sql: counts cast to ::bigint so sqlc emits int64,
-- and every read is a single round-trip.

-- THE WRITE IS NOT IN THIS FILE -- ON PURPOSE.
--
-- The flush statement is a multi-array unnest (`unnest(uuid[], timestamptz[],
-- ...)`) feeding one INSERT ... ON CONFLICT, so a flush covering N users costs
-- one round-trip instead of N.  sqlc cannot analyse that form: multi-argument
-- unnest is a ROWS FROM construct rather than an ordinary function, and sqlc's
-- catalogue has no signature for it (`function unnest(unknown, unknown, ...)
-- does not exist` at generate time).  Rewriting it as five single-array
-- unnests joined WITH ORDINALITY would type-check and would be materially
-- worse to read for no behavioural gain.
--
-- So it runs as a raw pgxpool query in internal/activity/recorder.go -- the
-- same escape hatch list_enrichment.go and list_users.go already use for SQL
-- sqlc cannot express.  It takes no user input: every value is a uuid, a
-- timestamp, or a counter this process accumulated.  The statement is quoted
-- in full there, including the WHERE EXISTS guard that keeps one deleted
-- account from discarding everybody else's counters.

-- name: GetActivitySnapshot :one
-- The four headline numbers, in one round-trip.
--
-- DAU / WAU / MAU are ROLLING windows ending today, not calendar week and
-- month.  Calendar buckets make the first of the month look like a collapse
-- and the last like a peak, and at this scale (tens of active accounts) that
-- artefact is larger than any real movement they would show.
--
-- The windows are inclusive of today and closed at the other end: DAU is today
-- alone, WAU is today and the six days before it, MAU today and the
-- twenty-nine before it.  Written as `>= today - 6` rather than `> today - 7`
-- because the first form is the one a reader can check against a calendar
-- without deciding whether the endpoint is open.
--
-- count(DISTINCT user_id) is not redundant on the DAU arm even though
-- (activity_date, user_id) is unique: it is written the same way in all three
-- so the three read as one measurement at three widths.  The planner
-- collapses it.
--
-- instrumented_since is the seam.  Rows seeded by 0026's backfill carry
-- request_count = 0 and the live recorder never leaves one there, so the
-- earliest date with a non-zero request_count is exactly the day per-request
-- recording began.  NULL means it has not started -- a container running the
-- migrations but not yet serving, or a rolled-back deploy -- and the caller
-- must render that as "not instrumented" rather than as a date.  Everything
-- before this date counts interaction days; everything after counts visits.
-- See 0026's header.
SELECT
    (SELECT count(DISTINCT user_id) FROM user_activity_daily
      WHERE activity_date = (now() AT TIME ZONE 'Asia/Shanghai')::date)::bigint          AS dau,
    (SELECT count(DISTINCT user_id) FROM user_activity_daily
      WHERE activity_date >= (now() AT TIME ZONE 'Asia/Shanghai')::date - 6)::bigint     AS wau,
    (SELECT count(DISTINCT user_id) FROM user_activity_daily
      WHERE activity_date >= (now() AT TIME ZONE 'Asia/Shanghai')::date - 29)::bigint    AS mau,
    -- The ::date cast is load-bearing exactly as the ::timestamptz in
    -- admin.sql's GetHantBackfillJobStatus is: without it sqlc cannot infer a
    -- type through the scalar subquery and emits interface{}.
    (SELECT min(activity_date) FROM user_activity_daily
      WHERE request_count > 0)::date                                                     AS instrumented_since;

-- name: ListActivityDailyTotals :many
-- One row per day that has any activity, within the window.
--
-- Days with nothing in them are ABSENT here and are filled in by the caller
-- (internal/admin/activity.go), not by a generate_series join.  That is a
-- deliberate split: "no row" and "a row of zeroes" are different claims -- one
-- says nobody came, the other says we did not look -- and deciding which is
-- which is logic worth unit-testing without a database attached.  The SQL
-- reports what happened; Go decides how to render an absence.
--
-- active_users is count(*) rather than count(DISTINCT user_id) because within
-- a single activity_date the primary key already guarantees one row per user.
-- The DISTINCT in GetActivitySnapshot is doing real work (its windows span
-- days); here it would only cost a sort.
SELECT
    activity_date,
    count(*)::bigint                         AS active_users,
    COALESCE(sum(request_count), 0)::bigint AS requests,
    COALESCE(sum(login_count),   0)::bigint AS logins
FROM user_activity_daily
WHERE activity_date >= (now() AT TIME ZONE 'Asia/Shanghai')::date
                       - (sqlc.arg('day_count')::integer - 1)
GROUP BY activity_date
ORDER BY activity_date;

-- name: ListNewUserCountsByDay :many
-- Signups per day, bucketed on the same +08 boundary so the "new" series and
-- the "active" series above line up bar for bar.  Bucketing these two
-- differently is the kind of mistake that produces a chart where a cohort
-- appears the day before it exists.
--
-- The predicate is deliberately non-sargable (it casts the column before
-- comparing, so no index on users.created_at can serve it).  users is a
-- four-figure table and this runs once per dashboard load; the alternative --
-- converting the local date bound back into a timestamptz range -- is two
-- casts in the opposite direction and one more place for the boundary to be
-- written down slightly differently.  Legibility wins until the table is
-- large enough for it not to.
SELECT
    (created_at AT TIME ZONE 'Asia/Shanghai')::date AS signup_date,
    count(*)::bigint                                AS new_users
FROM users
WHERE (created_at AT TIME ZONE 'Asia/Shanghai')::date
      >= (now() AT TIME ZONE 'Asia/Shanghai')::date - (sqlc.arg('day_count')::integer - 1)
GROUP BY 1
ORDER BY 1;

-- name: GetActivityRetention :one
-- Next-day, day-7, and ever-returned retention for the signup cohorts inside
-- the window.
--
-- THE DENOMINATORS ARE NOT THE SAME NUMBER, AND THAT IS THE WHOLE POINT.
-- Somebody who registered this morning has not failed to return tomorrow --
-- tomorrow has not happened.  Counting them in the day-1 denominator drags the
-- rate down by exactly the share of the window that is too young to answer,
-- which makes every retention figure look worse on the days you launch
-- something and gain signups.  So each horizon carries its own eligibility
-- gate: a cohort day counts toward d1 only once it is at least one day old,
-- toward d7 only once it is at least seven.  d1_cohort > d7_cohort is normal
-- and expected; they are different populations.
--
-- "Returned" is DAY-EXACT for d1 and d7 -- active on precisely signup + 1 /
-- signup + 7 -- which is the definition every analytics product in this market
-- uses and the one an operator will assume.  At this scale it is also a very
-- thin number: a handful of eligible accounts per week means a single person
-- moves the rate by ten points, so it is reported alongside a count and never
-- alone.
--
-- returned_ever is the honest companion, and the one worth reading first: any
-- activity on any day strictly after signup, over the whole window, with no
-- eligibility gate beyond having signed up at all.  It answers "did this
-- account ever come back", which at a few hundred signups is a number with
-- enough mass to mean something, and it is what makes a 0/3 day-7 figure
-- legible as sparsity rather than as catastrophe.
--
-- The three EXISTS probes hit (activity_date, user_id) -- the primary key --
-- so this stays index probes per cohort member rather than a scan, and needs
-- no index of its own.
--
-- Reads the backfilled rows as well as the recorded ones, which is correct
-- and worth naming: for a cohort older than `instrumented_since` the answer to
-- "did they come back" is really "did they come back AND leave a trace", so
-- historical retention is a floor, not a measurement.  Cohorts after the seam
-- are measured properly.
WITH bounds AS (
    SELECT
        (now() AT TIME ZONE 'Asia/Shanghai')::date                                   AS today,
        (now() AT TIME ZONE 'Asia/Shanghai')::date
            - (sqlc.arg('window_days')::integer - 1)                                 AS earliest
),
cohort AS (
    SELECT
        u.id                                                AS user_id,
        (u.created_at AT TIME ZONE 'Asia/Shanghai')::date   AS signup_date,
        EXISTS (
            SELECT 1 FROM user_activity_daily a
            WHERE a.user_id = u.id
              AND a.activity_date = (u.created_at AT TIME ZONE 'Asia/Shanghai')::date + 1
        )                                                   AS back_d1,
        EXISTS (
            SELECT 1 FROM user_activity_daily a
            WHERE a.user_id = u.id
              AND a.activity_date = (u.created_at AT TIME ZONE 'Asia/Shanghai')::date + 7
        )                                                   AS back_d7,
        EXISTS (
            SELECT 1 FROM user_activity_daily a
            WHERE a.user_id = u.id
              AND a.activity_date > (u.created_at AT TIME ZONE 'Asia/Shanghai')::date
        )                                                   AS back_ever
    FROM users u, bounds b
    WHERE (u.created_at AT TIME ZONE 'Asia/Shanghai')::date >= b.earliest
)
SELECT
    count(*) FILTER (WHERE c.signup_date <= b.today - 1)::bigint                 AS d1_cohort,
    count(*) FILTER (WHERE c.signup_date <= b.today - 1 AND c.back_d1)::bigint   AS d1_returned,
    count(*) FILTER (WHERE c.signup_date <= b.today - 7)::bigint                 AS d7_cohort,
    count(*) FILTER (WHERE c.signup_date <= b.today - 7 AND c.back_d7)::bigint   AS d7_returned,
    count(*)::bigint                                                             AS ever_cohort,
    count(*) FILTER (WHERE c.back_ever)::bigint                                  AS ever_returned
FROM cohort c, bounds b;

-- name: GetAdminUserActivityCounts :many
-- Last-seen, visit days, and logins for one page of the admin user table.
--
-- Same batch shape as GetAdminUserSubFollowCounts in admin.sql, and for the
-- same reason: thirty ids in, one round-trip, LEFT JOIN so an account with no
-- recorded activity comes back as a row of zeroes instead of vanishing from
-- the page.  (A missing row would silently drop the user from the table --
-- the exact failure mode a LEFT JOIN exists to prevent.)
--
-- last_seen_at is nullable and the NULL is meaningful: it says nothing has
-- ever been recorded for this account, which for an account created before
-- instrumentation began is a statement about our records and not about the
-- person.  The handler passes it through as null rather than substituting an
-- epoch or the signup date.
--
-- active_days counts rows, so before the seam it is interaction days and after
-- it, visit days -- the same caveat that applies to the chart.  It is the
-- honest ceiling on "how many days do we know this account was here".
SELECT
    u.id                                          AS user_id,
    -- The ::timestamptz is load-bearing.  u.id comes from an unnest, so sqlc
    -- loses the column types of this derived table and emits interface{} for
    -- anything it cannot pin down -- which would push a runtime type
    -- assertion into the handler for a value that is plainly a timestamp.
    -- (user_id keeps that fate; admin.sql's GetAdminUserSubFollowCounts has
    -- the same shape and list_users.go's asUUID already exists to absorb it.)
    max(a.last_seen_at)::timestamptz              AS last_seen_at,
    count(a.activity_date)::bigint                AS active_days,
    COALESCE(sum(a.login_count), 0)::bigint       AS logins
FROM unnest($1::uuid[]) AS u(id)
LEFT JOIN user_activity_daily a ON a.user_id = u.id
GROUP BY u.id;

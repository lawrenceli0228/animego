-- The reads behind GET /api/admin/activity (internal/admin/activity.go), plus
-- the per-user batch the admin user table needs.  The wire contract and the
-- definitions every number uses (person, signup day, returning, signup-only,
-- reconstructed) are in next-app/src/app/[lang]/admin/_types/activity.ts.
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
-- PEOPLE, NOT ACCOUNTS.  Every panel query reads the views activity_people and
-- activity_days (0054): the live tables plus the anonymous archive of deleted
-- accounts.  Deleting an account must not change any number about the past,
-- so no panel query reads `users` or `user_activity_daily` directly.  The
-- per-user batch at the bottom of the file is the deliberate exception: it
-- describes accounts, and a deleted account is not one.
--
-- ONE SNAPSHOT, ONE CLOCK.  The handler runs every panel query inside one
-- REPEATABLE READ READ ONLY transaction.  now() is the transaction's start
-- time, so each query below derives the same today from it on its own, and
-- every query reads the same snapshot: the parts of one response cannot
-- disagree with each other.  GetActivityClock hands that today to Go, which
-- fills the gaps in the daily series and judges the reconstructed flags
-- against it, never against the application server's clock.
--
-- ROWS ARE PEOPLE ON ONE DAY.  Both halves of activity_days have a primary key
-- leading with the date ((activity_date, user_id) and (activity_date,
-- archive_id)), so on a single date a row count is a count of people.  Across
-- several days the queries group by person.
--
-- NOTHING AFTER TODAY COUNTS.  Every range is closed at today, including the
-- "came back later" probes.  A row can be dated after the transaction's today
-- (a flush that commits right after midnight, or a clock a second ahead of the
-- database's); bounding everything at today keeps it out of every part of the
-- response at once instead of out of some parts only.
--
-- Conventions follow admin.sql: counts cast to ::bigint so sqlc emits int64,
-- and dates read through the views cast to ::date (the views hide the column
-- types from sqlc).

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

-- name: GetActivityClock :one
-- The snapshot's clock and the instrumentation seam.  The handler reads this
-- first and uses its today for everything it computes in Go.
--
-- instrumented_since: rows seeded by 0026's backfill carry request_count = 0
-- and the live recorder never leaves one there, so the earliest date with a
-- non-zero request_count is exactly the day per-request recording began.
-- Read over the union, so deleting the account that produced the earliest
-- live row does not move the seam (0054 copies request_count unchanged).
-- NULL means recording has not started -- a container running the migrations
-- but not yet serving -- and the caller must render that as "not
-- instrumented" rather than as a date.  Everything before this date counts
-- interaction days; everything from it on counts visits.  See 0026's header.
-- Closed at today like every other range here: a row dated after today
-- cannot start the seam on its own.
SELECT
    (now() AT TIME ZONE 'Asia/Shanghai')::date                               AS today,
    to_char(now() AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI')::text AS as_of,
    -- The ::date cast is load-bearing exactly as the ::timestamptz in
    -- admin.sql's GetHantBackfillJobStatus is: without it sqlc cannot infer a
    -- type through the scalar subquery and emits interface{}.
    (SELECT min(activity_date) FROM activity_days
      WHERE request_count > 0
        AND activity_date <= (now() AT TIME ZONE 'Asia/Shanghai')::date)::date AS instrumented_since;

-- name: GetActivityTodayActive :one
-- Today so far, against the same moment of yesterday and of seven days ago.
--
-- "The same moment" is a first_seen_at no later than exactly 24 (168) hours
-- before now().  Hours rather than '1 day' because day arithmetic on a
-- timestamptz follows the session's time zone and comes out at 23 or 25 hours
-- across a daylight-saving change there; the reporting zone has none, so 24
-- hours earlier is the same wall-clock time on the previous reporting day,
-- whatever zone the session happens to run in.
--
-- Both same-moment counts are returned unconditionally.  Whether the day they
-- describe is instrumented enough for a time of day to mean anything (0026's
-- rows carry the time of an interaction, not of a visit) is the handler's
-- call, made against instrumented_since.
WITH clock AS (
    SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date AS today
)
SELECT
    count(*) FILTER (WHERE d.activity_date = c.today)::bigint             AS active,
    count(*) FILTER (WHERE d.activity_date = c.today - 1
                       AND d.first_seen_at <= now() - interval '24 hours')::bigint
                                                                           AS same_time_yesterday,
    count(*) FILTER (WHERE d.activity_date = c.today - 7
                       AND d.first_seen_at <= now() - interval '168 hours')::bigint
                                                                           AS same_time_last_week,
    count(*) FILTER (WHERE d.activity_date = c.today - 1)::bigint         AS yesterday_total
FROM activity_days d
CROSS JOIN clock c
WHERE d.activity_date IN (c.today, c.today - 1, c.today - 7);

-- name: GetActivityWindow :one
-- One window of `days` days ending today, [today-(days-1), today], and the
-- window of the same length right before it, [today-(2*days-1), today-days],
-- each split into returning and signup-only people.  Called once per window
-- (7 and 30); the handler derives the reconstructed flags from the same
-- `days`, so the ranges have one definition.
--
-- Per person and window: RETURNING if any of their rows in the window is not
-- on their signup day; SIGNUP-ONLY if they have rows in the window and every
-- one of them is on their signup day.  The two are complementary among the
-- people with a row in the window, so active = returning + signupOnly is a
-- partition, not an approximation, and the handler adds them up rather than
-- counting active a third time.  created_at is NOT NULL on both halves of
-- activity_people, so `<> signup_day` never yields NULL and nobody falls
-- between the two counts.
WITH clock AS (
    SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date AS today
),
bounds AS (
    SELECT c.today,
           c.today - (sqlc.arg('days')::integer - 1)     AS window_start,
           c.today - (2 * sqlc.arg('days')::integer - 1) AS prev_start
    FROM clock c
),
people AS (
    SELECT person_id, (created_at AT TIME ZONE 'Asia/Shanghai')::date AS signup_day
    FROM activity_people
),
per_person AS (
    SELECT
        bool_or(d.activity_date >= b.window_start)                                 AS in_window,
        bool_or(d.activity_date >= b.window_start AND d.activity_date <> p.signup_day) AS back_in_window,
        bool_or(d.activity_date <  b.window_start)                                 AS in_prev,
        bool_or(d.activity_date <  b.window_start AND d.activity_date <> p.signup_day) AS back_in_prev
    FROM activity_days d
    JOIN people p ON p.person_id = d.person_id
    CROSS JOIN bounds b
    WHERE d.activity_date BETWEEN b.prev_start AND b.today
    GROUP BY d.person_id
)
SELECT
    count(*) FILTER (WHERE back_in_window)::bigint                   AS returning_people,
    count(*) FILTER (WHERE in_window AND NOT back_in_window)::bigint AS signup_only_people,
    count(*) FILTER (WHERE back_in_prev)::bigint                     AS prev_returning_people,
    count(*) FILTER (WHERE in_prev AND NOT back_in_prev)::bigint     AS prev_signup_only_people
FROM per_person;

-- name: GetActivitySignups :one
-- People whose signup day falls in the window of `days` days ending today,
-- the same count for the window before it, and how many of the first group
-- were active on any day after their signup day (up to today).
--
-- Signups are never reconstructed -- created_at is a recorded instant -- but
-- returned_after is read from activity_days and undercounts for signups whose
-- days after signup predate instrumented_since.
WITH clock AS (
    SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date AS today
),
bounds AS (
    SELECT c.today,
           c.today - (sqlc.arg('days')::integer - 1)     AS window_start,
           c.today - (2 * sqlc.arg('days')::integer - 1) AS prev_start
    FROM clock c
),
recent AS (
    SELECT
        s.signup_day,
        EXISTS (
            SELECT 1 FROM activity_days d
            WHERE d.person_id = p.person_id
              AND d.activity_date > s.signup_day
              AND d.activity_date <= b.today
        ) AS came_back
    FROM activity_people p
    CROSS JOIN bounds b
    CROSS JOIN LATERAL (
        SELECT (p.created_at AT TIME ZONE 'Asia/Shanghai')::date AS signup_day
    ) s
    WHERE s.signup_day BETWEEN b.prev_start AND b.today
)
SELECT
    count(*) FILTER (WHERE r.signup_day >= b.window_start)::bigint                 AS signups,
    count(*) FILTER (WHERE r.signup_day <  b.window_start)::bigint                 AS prev_signups,
    count(*) FILTER (WHERE r.signup_day >= b.window_start AND r.came_back)::bigint AS returned_after
FROM recent r
CROSS JOIN bounds b;

-- name: ListActivityDaily :many
-- One row per day that has any activity in [today-(day_count-1), today]: the
-- people active that day split by whether it is their signup day, and the
-- day's request and login totals.
--
-- Days with nothing in them are ABSENT here and are filled in by the caller
-- (internal/admin/activity.go), not by a generate_series join.  That is a
-- deliberate split: "no row" and "a row of zeroes" are different claims -- one
-- says nobody came, the other says we did not look -- and deciding which is
-- which is logic worth unit-testing without a database attached.  The SQL
-- reports what happened; Go decides how to render an absence.
--
-- The inner join to activity_people loses no row: each half of activity_days
-- has a foreign key into its half of activity_people.  So returning +
-- signup_day is the day's row count and the request and login sums cover
-- every row.
WITH clock AS (
    SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date AS today
),
people AS (
    SELECT person_id, (created_at AT TIME ZONE 'Asia/Shanghai')::date AS signup_day
    FROM activity_people
)
SELECT
    d.activity_date::date                                             AS activity_date,
    count(*) FILTER (WHERE d.activity_date <> p.signup_day)::bigint   AS returning_people,
    count(*) FILTER (WHERE d.activity_date =  p.signup_day)::bigint   AS signup_day_people,
    COALESCE(sum(d.request_count), 0)::bigint                         AS requests,
    COALESCE(sum(d.login_count),   0)::bigint                         AS logins
FROM activity_days d
JOIN people p ON p.person_id = d.person_id
CROSS JOIN clock c
WHERE d.activity_date BETWEEN c.today - (sqlc.arg('day_count')::integer - 1) AND c.today
GROUP BY d.activity_date
ORDER BY d.activity_date;

-- name: ListActivityDepth :many
-- How many distinct days each person active in [today-(day_count-1), today]
-- was active in it, as a histogram: one row per day count, with how many
-- people have it and how many of those are signup-only (their only day in
-- the window is their signup day, which also makes their day count 1).
--
-- The handler folds the histogram into the panel's buckets.  Its people sum
-- is the window's active count -- the same set GetActivityWindow partitions
-- -- so the two agree whenever day_count is one of the fixed windows.
WITH clock AS (
    SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date AS today
),
people AS (
    SELECT person_id, (created_at AT TIME ZONE 'Asia/Shanghai')::date AS signup_day
    FROM activity_people
),
per_person AS (
    SELECT
        count(DISTINCT d.activity_date)          AS active_days,
        bool_or(d.activity_date <> p.signup_day) AS came_back
    FROM activity_days d
    JOIN people p ON p.person_id = d.person_id
    CROSS JOIN clock c
    WHERE d.activity_date BETWEEN c.today - (sqlc.arg('day_count')::integer - 1) AND c.today
    GROUP BY d.person_id
)
SELECT
    active_days::bigint                           AS active_days,
    count(*)::bigint                              AS people,
    count(*) FILTER (WHERE NOT came_back)::bigint AS signup_only
FROM per_person
GROUP BY active_days
ORDER BY active_days;

-- name: ListActivityCohorts :many
-- Signup cohorts by Monday-start week: the current week and the `weeks - 1`
-- before it, newest first, one row per week whether or not anybody signed up
-- in it.
--
-- A member is a person whose signup day falls in [week_start, week_start+6].
-- returned_N counts members active on some day d with
-- signup_day < d <= signup_day + N, read as "their first day back is no later
-- than signup_day + N".  N is 1, 7, 14 and 30; the handler lists the horizons
-- in that order and must change with these columns.  A horizon still open
-- for some member is counted here all the same -- eligibility is judged in Go
-- from last_signup and today, and a still-growing count is never shown as a
-- rate.
--
-- The week is truncated on a timestamp WITHOUT time zone, so the Monday comes
-- from the calendar alone and not from the session's zone.
WITH clock AS (
    SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date AS today
),
weeks AS (
    SELECT (date_trunc('week', c.today::timestamp)::date - 7 * k.n)::date AS week_start
    FROM clock c
    CROSS JOIN generate_series(0, sqlc.arg('weeks')::integer - 1) AS k(n)
),
members AS (
    SELECT
        s.signup_day,
        (SELECT min(d.activity_date)
           FROM activity_days d
          WHERE d.person_id = p.person_id
            AND d.activity_date > s.signup_day
            AND d.activity_date <= c.today) AS first_return
    FROM activity_people p
    CROSS JOIN clock c
    CROSS JOIN LATERAL (
        SELECT (p.created_at AT TIME ZONE 'Asia/Shanghai')::date AS signup_day
    ) s
    WHERE s.signup_day >= (SELECT min(week_start) FROM weeks)
      AND s.signup_day <= c.today
)
SELECT
    w.week_start::date                                                 AS week_start,
    count(m.signup_day)::bigint                                        AS signups,
    max(m.signup_day)::date                                            AS last_signup,
    count(*) FILTER (WHERE m.first_return <= m.signup_day + 1)::bigint  AS returned_1,
    count(*) FILTER (WHERE m.first_return <= m.signup_day + 7)::bigint  AS returned_7,
    count(*) FILTER (WHERE m.first_return <= m.signup_day + 14)::bigint AS returned_14,
    count(*) FILTER (WHERE m.first_return <= m.signup_day + 30)::bigint AS returned_30
FROM weeks w
LEFT JOIN members m ON m.signup_day BETWEEN w.week_start AND w.week_start + 6
GROUP BY w.week_start
ORDER BY w.week_start DESC;

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

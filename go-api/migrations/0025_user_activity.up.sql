-- go-api/migrations/0025_user_activity.up.sql
-- Presence, as a recorded fact rather than an inference from social writes.
--
-- WHAT WAS MISSING, PRECISELY.  The admin page could already answer "how many
-- accounts exist", "what has each of them subscribed to or commented on", and
-- "how often did the homepage discussion rail get clicked".  None of those is
-- activity.  activity_events (0018) only ever holds watch_progress / comment /
-- follow -- three deliberate social actions -- so a reader who visits every
-- evening, watches nothing to completion and posts nothing is, to every query
-- this repo can currently write, indistinguishable from a user who registered
-- once and never came back.  community_engagement_daily (0020) is aggregate by
-- construction and carries no user column at all, on purpose.
--
-- So DAU/WAU/MAU, "when was this account last here", "how many days has it
-- shown up", and next-day / day-7 retention were not hard queries against the
-- existing schema.  They were unanswerable.  This migration adds the table
-- that makes them answerable, and nothing else.
--
--
-- THE DAY BOUNDARY IS +08:00, NOT UTC.  Every date column below is bucketed in
-- Asia/Shanghai, because that is where the readers are.  Under UTC bucketing
-- the 00:00-08:00 CST slice of an evening -- prime viewing hours in this
-- catalogue -- lands on the previous calendar day, which smears one person's
-- single evening across two "active days" and inflates both the daily trend
-- and the visit-day count.  The offset is fixed and historical: China has had
-- no DST since 1991, so a literal +08 is exact, not an approximation, and
-- carries no dependency on the container's tzdata.
--
-- The writer (internal/activity) computes the same boundary with a fixed
-- time.FixedZone(+8h).  The two MUST agree; see Day() there.
--
--
-- ONE TABLE, PER USER PER DAY.  It has to be per-user rather than a pre-summed
-- daily total, because every headline number here counts DISTINCT PEOPLE and
-- you cannot recover a distinct-person count from a sum.
--
-- WHAT THIS TABLE DOES NOT COVER, SAID OUT LOUD: logged-out visitors.  Every
-- row is keyed on a user id, so anonymous readers -- the majority of a
-- search-led catalogue -- are invisible to all of it.  An earlier revision
-- added a second, aggregate, no-user-column table fed by a public browser
-- beacon to close that gap.  It was removed before shipping: every beacon was
-- an origin request that Cloudflare's edge cache would otherwise have
-- absorbed, and it spent from the same per-IP rate-limit budget as real API
-- calls, so the cost landed on the reader.  If anonymous coverage is wanted
-- later, take it from nginx / Cloudflare logs, not from a write endpoint on
-- the hot path.


-- The foreign key below takes a ShareRowExclusive lock on `users` for the
-- duration of the DDL.  `users` is a four-figure table and this runs inside
-- the deploy window, so the lock itself is instant -- but if any long
-- transaction happens to be holding a conflicting lock, an unbounded DDL wait
-- queues every subsequent login and profile write behind it.  Failing fast and
-- letting the deploy retry is strictly better than a lock convoy on the one
-- table every authenticated request touches.
SET lock_timeout = '3s';

CREATE TABLE user_activity_daily (
    user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    activity_date date NOT NULL,

    -- Wall-clock bounds of the day's presence.  first_seen_at is what makes a
    -- "session-like" reading possible later without storing sessions; it is
    -- also the only field that distinguishes "logged in at 23:58" from "was
    -- here all day", which matters when a single row is all the evidence a
    -- retention cohort has.
    first_seen_at timestamptz NOT NULL,
    last_seen_at  timestamptz NOT NULL,

    -- Authenticated API calls attributed to this user on this day.
    --
    -- This counter is load-bearing beyond its face value: it is ALSO the
    -- marker that separates rows written by the live recorder from rows
    -- seeded by 0026's historical backfill, which writes 0 here and can never
    -- write anything else.  `min(activity_date) FILTER (WHERE request_count >
    -- 0)` is therefore the exact date instrumentation began, derived from the
    -- data instead of from a hand-maintained constant that would drift.  The
    -- admin endpoint reports it so the chart can mark the boundary, because
    -- the backfilled span counts interaction days only and the instrumented
    -- span counts every visit -- graphed together with no divider, the switch
    -- looks like a growth spike and will be read as one.
    --
    -- Read it as requests, not as actions: SSR fan-out and client polling both
    -- land here.  It is a volume signal, not an engagement one.
    request_count bigint NOT NULL DEFAULT 0,

    -- Successful password logins.  Deliberately NOT "sessions": the refresh
    -- token lives 7 days, so a daily reader logs in roughly never and a zero
    -- here is the normal, healthy state for an engaged account.  It is useful
    -- as the denominator-free counterpart to "returning without logging in",
    -- and as the one activity signal that predates any client instrumentation.
    login_count bigint NOT NULL DEFAULT 0,

    -- (activity_date, user_id), in that order, and the order is the point.
    -- Every aggregate read here -- DAU, the daily trend, the retention
    -- cohorts, the whole surface of the dashboard -- is a scan of a bounded
    -- date range, so the date must lead for the range to be a single index
    -- range scan rather than a filter over the whole table.  The per-user
    -- reads that want the other order get their own index below.
    PRIMARY KEY (activity_date, user_id),

    CONSTRAINT user_activity_daily_counts_chk CHECK (
        request_count >= 0 AND login_count >= 0
    ),
    -- A row whose last_seen precedes its first_seen is not a small
    -- inaccuracy, it is a writer bug (a flush applying an older buffer over a
    -- newer one).  The upsert uses LEAST/GREATEST precisely so this can never
    -- happen; the constraint is what makes that claim checkable instead of
    -- merely intended.
    CONSTRAINT user_activity_daily_window_chk CHECK (last_seen_at >= first_seen_at)
);

-- The per-user direction: "when was this account last here" and "how many days
-- has it shown up", both scoped to the 30 accounts on one page of the admin
-- user table.  Without this, each of those is a scan of every date partition
-- of the primary key.  DESC because every such read wants the newest first and
-- usually only wants one row.
CREATE INDEX idx_user_activity_daily_user
    ON user_activity_daily (user_id, activity_date DESC);

-- Retention's shape, spelled out here because the query that uses it is not
-- obvious from the table alone: a cohort is `users.created_at` bucketed to the
-- same +08 day, and "returned on day N" is EXISTS(a row at cohort_day + N).
-- That is a probe of the primary key by (date, user_id) -- already covered --
-- so retention needs no index of its own.  It does need users.created_at
-- bucketed the same way, which is why the admin query casts it rather than
-- comparing raw timestamps.

-- Retention: 400 days on the per-user table.
--
-- 400 rather than 365 so a year-over-year comparison still has both endpoints
-- on the day it is asked for; a 365-day window drops last year's figure the
-- morning you want to compare against it.
--
-- Volume is not the reason for the cap.  At the current scale this table grows
-- by at most a few hundred rows a day, so a year is tens of thousands of rows
-- and the prune saves nothing worth measuring.  The cap is here because 0018
-- shipped activity_events with no retention policy at all and 0021 had to
-- retrofit one under time pressure once library sync started writing a row per
-- finished episode.  A table that accumulates one row per person per day has
-- exactly that shape, so the ceiling goes in with the table.
--
-- 05:00 UTC keeps this clear of the danmaku TTL (04:00, 0006) and the
-- activity_events prune (04:30, 0021) so the three never contend for the same
-- pg_cron worker slot.  Unlike 0021 this one needs no chunking: the delete is
-- a primary-key range scan bounded by date, and a day's worth of rows is
-- three orders of magnitude smaller than the 5 000-row chunk that migration
-- had to reach for.
SELECT cron.schedule(
    'user-activity-daily-prune',
    '0 5 * * *',
    $job$
DELETE FROM user_activity_daily
WHERE activity_date < ((now() AT TIME ZONE 'Asia/Shanghai')::date - 400);
$job$
);

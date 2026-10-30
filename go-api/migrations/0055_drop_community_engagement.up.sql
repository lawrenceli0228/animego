-- go-api/migrations/0055_drop_community_engagement.up.sql
-- Drops the community engagement counters (0020, widened by 0028).
--
-- They counted impressions and opens of the homepage discussion rail and the
-- welcome card pinned inside it.  The homepage no longer renders that rail,
-- so nothing emits those events, and the code that wrote and read the table
-- is removed in the same change as this file.
--
-- idx_episode_comments_recent_discovery, created by the same 0020 file, is
-- deliberately left alone: GET /api/community/discussions/trending still
-- scans it for its time window.
--
-- A build that predates 0055 answers POST /api/community/engagement and
-- GET /api/admin/community-metrics with a 500 once this has run.  No page
-- calls the first any more, and the admin page treats a failed second call
-- as "no data" and hides its cards.

DROP INDEX IF EXISTS idx_community_engagement_daily_date;
DROP TABLE IF EXISTS community_engagement_daily;

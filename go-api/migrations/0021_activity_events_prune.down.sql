-- go-api/migrations/0021_activity_events_prune.down.sql
-- Mirror of the up migration: drop the schedule first, then the index that
-- only existed to keep the schedule cheap.
--
-- Rows the job already expired are gone for good.  A retention prune is not
-- reversible and this migration deliberately does not pretend otherwise --
-- rolling back stops future deletions, it does not resurrect past ones.
--
-- Same shape as 0006_danmaku_ttl_schedule.down.sql: a bare cron.unschedule()
-- by job name.  It raises if the job is already gone (someone unscheduled it
-- by hand), which is exactly how 0006 behaves.

SELECT cron.unschedule('activity-events-prune');

DROP INDEX IF EXISTS idx_notifications_activity_event;

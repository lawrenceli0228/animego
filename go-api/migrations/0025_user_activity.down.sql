-- go-api/migrations/0025_user_activity.down.sql
-- Mirror of the up migration, in reverse dependency order: unschedule first
-- (the job references a table that is about to stop existing), then drop.
--
-- Same shape as 0006/0021's down: a bare cron.unschedule() by job name, which
-- raises if the job is already gone because somebody removed it by hand.  That
-- is the established behaviour here and it is the honest one -- a silent
-- no-op would hide the fact that the schedule was not where the migration
-- left it.
--
-- Rolling this back destroys every recorded visit.  Nothing else holds that
-- data: the recorder writes here and only here, and 0026's backfill can
-- reconstruct only the interaction days that other tables happen to witness,
-- never the plain visits this table exists to capture.  Rolling forward past
-- a mistake is cheaper than rolling back through one.

SELECT cron.unschedule('user-activity-daily-prune');

DROP INDEX IF EXISTS idx_activity_surface_daily_date;
DROP TABLE IF EXISTS activity_surface_daily;

DROP INDEX IF EXISTS idx_user_activity_daily_user;
DROP TABLE IF EXISTS user_activity_daily;

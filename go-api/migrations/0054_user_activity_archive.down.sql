-- go-api/migrations/0054_user_activity_archive.down.sql
-- Drops the archive and the views over it.  The archived rows go with it: a
-- re-up starts an empty archive, and accounts deleted in between are once
-- again subtracted from the history.

SELECT cron.unschedule('user-activity-archive-prune');

DROP VIEW IF EXISTS activity_days;
DROP VIEW IF EXISTS activity_people;
DROP INDEX IF EXISTS idx_archived_user_activity_daily_person;
DROP TABLE IF EXISTS archived_user_activity_daily;
DROP INDEX IF EXISTS idx_archived_users_created;
DROP TABLE IF EXISTS archived_users;

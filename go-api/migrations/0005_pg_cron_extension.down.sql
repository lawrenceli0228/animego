-- go-api/migrations/0005_pg_cron_extension.down.sql
-- Drop pg_cron.  This also evicts any scheduled jobs registered against
-- cron.job — so make sure 0006_danmaku_ttl_schedule's down migration ran
-- before this one (golang-migrate enforces order, but be aware).

DROP EXTENSION IF EXISTS pg_cron;

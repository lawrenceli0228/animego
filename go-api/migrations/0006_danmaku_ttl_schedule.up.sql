-- go-api/migrations/0006_danmaku_ttl_schedule.up.sql
-- Schedule the danmaku 1-year TTL via pg_cron.  Runs at 04:00 UTC daily
-- (low-traffic for HK userbase).  Quoting trick: the command body uses
-- dollar-quoted string so SQL keywords don't need escaping.

SELECT cron.schedule(
    'danmaku-ttl',
    '0 4 * * *',
    $$DELETE FROM danmakus WHERE created_at < NOW() - INTERVAL '1 year'$$
);

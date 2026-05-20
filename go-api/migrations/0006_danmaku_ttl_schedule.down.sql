-- go-api/migrations/0006_danmaku_ttl_schedule.down.sql

SELECT cron.unschedule('danmaku-ttl');

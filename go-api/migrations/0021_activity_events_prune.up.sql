-- go-api/migrations/0021_activity_events_prune.up.sql
-- Prune activity_events on a 90-day retention window via pg_cron.
--
-- 0018 created activity_events with no retention policy at all.  That was
-- survivable while the only writers were hand-triggered social actions
-- (prod holds 2 watch_progress rows total), but library <-> watch-progress
-- sync turns every finished episode into a row: one binge of a 24-episode
-- season is 24 inserts from a single user in one evening.  The prune goes in
-- before the write rate arrives, not after.
--
-- Shape is lifted from 0006_danmaku_ttl_schedule: a single cron.schedule()
-- call with a dollar-quoted command body, and a matching cron.unschedule()
-- in the down migration.  Re-applying is safe: pg_cron >= 1.4 (the image
-- builds 1.6.5, see go-api/docker/postgres/Dockerfile) upserts cron.job on
-- (jobname, username), so a second run replaces the row instead of raising.
--
-- Scope: event_type = 'watch_progress' only.
--   * 'comment' and 'follow' events are the durable record behind a
--     profile timeline, and both are referenced by
--     notifications.activity_event_id (ON DELETE SET NULL) -- expiring them
--     would silently blank the deep link on a notification the recipient may
--     never have opened.  watch_progress rows are never referenced by a
--     notification (notification_type is only reply/reaction/follow), so
--     pruning them cannot orphan anything.
--   * watch_progress is also the only type whose volume scales with viewing
--     instead of with social actions, so it is the only one that needs a
--     ceiling today.
--
-- Timing: 04:30 UTC, half an hour behind the danmaku TTL, so the two prunes
-- do not contend for the same pg_cron worker slot and IO window.
--
-- Batching: the delete runs in 5 000-row chunks with a hard cap of 200
-- rounds (1 000 000 rows per night) instead of one unbounded DELETE.  The
-- chunk bounds how much work any single statement does -- activity_events
-- has no index covering (event_type, created_at), so each pass is a
-- sequential scan that stops early once LIMIT is satisfied -- and the round
-- cap stops a backlog (job disabled for a month, say) from becoming one
-- multi-hour statement.  Note the rounds share a transaction: pg_cron
-- submits the job body as one command, so locks release when the run
-- commits, not per chunk.  That is fine while the table is append-only and
-- nothing else updates these rows.

SELECT cron.schedule(
    'activity-events-prune',
    '30 4 * * *',
    $job$
DO $prune$
DECLARE
    deleted integer;
    rounds  integer := 0;
BEGIN
    LOOP
        DELETE FROM activity_events
        WHERE id IN (
            SELECT id
            FROM activity_events
            WHERE event_type = 'watch_progress'
              AND created_at < NOW() - INTERVAL '90 days'
            LIMIT 5000
        );
        GET DIAGNOSTICS deleted = ROW_COUNT;
        rounds := rounds + 1;
        EXIT WHEN deleted = 0 OR rounds >= 200;
    END LOOP;

    -- Hitting the cap with rows still coming back means the backlog outran a
    -- single night.  Say so in the server log rather than stopping quietly:
    -- this repo has already lost a month to a scheduled job that failed with
    -- nobody watching (refresh-bgm-map).
    IF rounds >= 200 AND deleted > 0 THEN
        RAISE WARNING 'activity-events-prune: stopped at the 200-round cap with expired rows remaining; the backlog carries to the next run';
    END IF;
END
$prune$;
$job$
);

-- notifications.activity_event_id is an unindexed foreign key with
-- ON DELETE SET NULL.  Postgres enforces that with a per-deleted-row
-- referential trigger -- effectively
-- `UPDATE notifications SET activity_event_id = NULL WHERE activity_event_id = $1`
-- for every parent row the prune removes.  Without an index that is one
-- sequential scan of notifications per pruned row, which makes the job above
-- O(pruned rows x notifications rows) and turns a nightly cleanup into the
-- exact kind of statement that stalls prod.  The index costs one more entry
-- per notification insert (a social action, not an episode), so it is cheap
-- on the write side and is what makes the batching above actually bounded.
CREATE INDEX IF NOT EXISTS idx_notifications_activity_event
    ON notifications (activity_event_id);

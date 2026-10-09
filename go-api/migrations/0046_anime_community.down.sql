-- Roll back 0046.  Roll the code back to a build that predates it first:
-- the subscription writes append 'status' events and the community
-- endpoints read every table this drops.
--
-- THIS LOSES DATA, and the DELETEs are not tidying.  ADD CONSTRAINT
-- re-validates every row, so any row of a kind the 0045 schema cannot
-- represent -- a 'status' event, a thread/activity reply notification, a
-- report of a review, thread or reply -- has to be gone before the narrower
-- constraint goes back on, or the rollback aborts half-applied.  Every
-- review, vote, thread, reply and like goes with the tables.
--
-- Order: reports, notifications, the new tables (children first), then
-- activity_events.

SET lock_timeout = '3s';

-- reports ------------------------------------------------------------------

DELETE FROM reports WHERE target_type IN ('review', 'thread', 'reply');

DROP INDEX IF EXISTS reports_pending_review_uniq;
DROP INDEX IF EXISTS reports_pending_thread_uniq;
DROP INDEX IF EXISTS reports_pending_reply_uniq;

ALTER TABLE reports DROP CONSTRAINT reports_target_shape_chk;
ALTER TABLE reports DROP CONSTRAINT reports_target_type_chk;

ALTER TABLE reports
    DROP COLUMN target_review_id,
    DROP COLUMN target_thread_id,
    DROP COLUMN target_reply_id;

ALTER TABLE reports ADD CONSTRAINT reports_target_type_chk
    CHECK (target_type IN ('comment', 'user'));
ALTER TABLE reports ADD CONSTRAINT reports_target_shape_chk CHECK (
    (target_type = 'comment' AND target_user_id IS NULL)
    OR
    (target_type = 'user' AND target_comment_id IS NULL)
);

-- notifications --------------------------------------------------------------

DELETE FROM notifications
    WHERE notification_type IN ('thread_reply', 'activity_reply');

DROP INDEX IF EXISTS idx_notifications_reply;
ALTER TABLE notifications DROP CONSTRAINT notifications_reply_target_chk;
ALTER TABLE notifications DROP CONSTRAINT notifications_type_chk;
ALTER TABLE notifications DROP COLUMN reply_id;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_chk
    CHECK (notification_type IN ('reply', 'reaction', 'follow'));

-- the new tables ---------------------------------------------------------------

DROP TABLE IF EXISTS activity_likes;
DROP TABLE IF EXISTS community_replies;
DROP TABLE IF EXISTS anime_threads;
DROP TABLE IF EXISTS anime_review_votes;
DROP TABLE IF EXISTS anime_reviews;

-- activity_events ----------------------------------------------------------

DELETE FROM activity_events WHERE event_type = 'status';

DROP INDEX IF EXISTS idx_activity_events_anime_status;

ALTER TABLE activity_events DROP CONSTRAINT activity_events_shape_chk;
ALTER TABLE activity_events DROP CONSTRAINT activity_events_type_chk;
ALTER TABLE activity_events DROP COLUMN status;

ALTER TABLE activity_events ADD CONSTRAINT activity_events_type_chk
    CHECK (event_type IN ('watch_progress', 'comment', 'follow'));
ALTER TABLE activity_events ADD CONSTRAINT activity_events_shape_chk CHECK (
    (event_type = 'watch_progress'
        AND anilist_id IS NOT NULL AND episode IS NOT NULL
        AND comment_id IS NULL AND target_user_id IS NULL)
    OR
    (event_type = 'comment'
        AND anilist_id IS NOT NULL AND episode IS NOT NULL
        AND comment_id IS NOT NULL AND target_user_id IS NULL)
    OR
    (event_type = 'follow'
        AND anilist_id IS NULL AND episode IS NULL
        AND comment_id IS NULL AND target_user_id IS NOT NULL)
);

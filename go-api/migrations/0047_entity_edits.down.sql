-- Roll the code back to a build that predates 0047 before running this:
-- the person, character and anime reads join entity_overlays, and the
-- notification list joins edit_submissions.
--
-- Accepted edits live only in entity_overlays, so this drops them for
-- good; export the table first if they are wanted back.  The images they
-- name stay on the volume.
--
-- notifications_type_chk goes back to 0046's list, which is what precedes
-- this file in the shipped order (see the up file).  The edit_review rows
-- go first: the restored constraint would refuse them.

SET lock_timeout = '3s';

DELETE FROM notifications WHERE notification_type = 'edit_review';

DROP INDEX IF EXISTS idx_notifications_edit_submission;
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_edit_target_chk;
ALTER TABLE notifications DROP CONSTRAINT notifications_type_chk;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_chk
    CHECK (notification_type IN (
        'reply', 'reaction', 'follow', 'thread_reply', 'activity_reply'
    ));
ALTER TABLE notifications DROP COLUMN IF EXISTS edit_submission_id;

DROP TABLE IF EXISTS entity_overlays;
DROP TABLE IF EXISTS edit_items;
DROP TABLE IF EXISTS edit_submissions;

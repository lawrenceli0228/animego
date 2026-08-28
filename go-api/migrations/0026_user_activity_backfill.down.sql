-- go-api/migrations/0026_user_activity_backfill.down.sql
-- Undo the seed without touching anything the live recorder wrote.
--
-- request_count = 0 is the marker 0026's insert stamps on every backfilled row
-- and the recorder never leaves in place -- its first flush of a day
-- increments it above zero.  So the predicate below removes exactly the rows
-- this migration created, and a row that has since seen real traffic is left
-- alone even though it started life here.
--
-- The one thing it cannot restore is a first_seen_at that ON CONFLICT widened
-- backwards on a row the recorder already owned.  That is a wider window on a
-- day that genuinely had earlier evidence, not a wrong one, and unwinding it
-- would require remembering a value nothing stored.  Named so nobody hunts for
-- the missing half.

DELETE FROM user_activity_daily
WHERE request_count = 0
  AND login_count = 0;

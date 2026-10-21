-- Throws away every per-device session.  Not part of a rollback: redeploy the
-- previous build and leave 0052 applied (see the up migration).  Run this only
-- when abandoning per-device sessions for good, after the code that reads the
-- table is gone; anyone who signed in since 0052 then signs in again.
DROP TRIGGER IF EXISTS users_password_ends_sessions ON users;
DROP FUNCTION IF EXISTS user_sessions_end_on_password_change();
DROP TABLE IF EXISTS user_sessions;

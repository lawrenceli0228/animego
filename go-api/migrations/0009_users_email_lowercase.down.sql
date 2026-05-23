-- 0009_users_email_lowercase.down.sql
-- Reverse 0009: drop the lowercase CHECK.  Existing rows stay
-- lowercased (no automatic un-lowercase since we don't know which
-- characters were originally uppercase).

ALTER TABLE users
    DROP CONSTRAINT IF EXISTS users_email_lowercase_chk;

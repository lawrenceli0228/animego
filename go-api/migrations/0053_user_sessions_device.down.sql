-- Drops the device columns. Roll the code back to a build that predates 0053
-- first: every session write since names them.
ALTER TABLE user_sessions
    DROP COLUMN IF EXISTS user_agent,
    DROP COLUMN IF EXISTS country,
    DROP COLUMN IF EXISTS city;

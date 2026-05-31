-- 0010_refresh_token_grace.down.sql
-- Reverse 0010: drop the two grace-window columns.

ALTER TABLE users
    DROP COLUMN IF EXISTS previous_refresh_token,
    DROP COLUMN IF EXISTS refresh_rotated_at;

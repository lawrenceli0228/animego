DROP TABLE IF EXISTS reports;
DROP TABLE IF EXISTS user_blocks;

ALTER TABLE episode_comments
    DROP COLUMN IF EXISTS is_spoiler;

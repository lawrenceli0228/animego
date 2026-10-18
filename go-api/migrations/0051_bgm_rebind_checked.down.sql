-- Roll the code back to a build that predates 0051 before running this: the
-- rebind sweep and the three reset statements all write this column.
--
-- The column is also the only record of which bindings the sweep made
-- (bgm_match_source = 'fuzzy_high' AND bgm_rebind_checked_at IS NOT NULL).
-- If the reason for rolling back is a bad bind, export that list first:
--
--   SELECT anilist_id, bgm_id, title_chinese, bgm_rebind_checked_at
--     FROM anime_cache
--    WHERE bgm_match_source = 'fuzzy_high' AND bgm_rebind_checked_at IS NOT NULL;
SET lock_timeout = '3s';

ALTER TABLE anime_cache DROP COLUMN IF EXISTS bgm_rebind_checked_at;

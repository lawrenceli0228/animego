-- Reverse 0011_match_accuracy.
DROP TABLE IF EXISTS ddp_bgm_title;
DROP TABLE IF EXISTS bgm_id_map;
ALTER TABLE anime_cache DROP COLUMN IF EXISTS bgm_match_source;

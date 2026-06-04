-- Reverse 0013_bgm_id_map_anidb.
ALTER TABLE bgm_id_map DROP COLUMN IF EXISTS anidb_id;

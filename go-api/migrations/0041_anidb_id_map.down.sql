-- GetTorrentQueryInputsByAnilistID reads this table; roll the code back to a
-- build that reads bgm_id_map.anidb_id before running this.
DROP TABLE IF EXISTS anidb_id_map;

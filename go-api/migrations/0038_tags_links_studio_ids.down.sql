ALTER TABLE anime_studios DROP CONSTRAINT anime_studios_id_positive;
DROP INDEX anime_studios_studio_id_idx;
ALTER TABLE anime_studios DROP COLUMN is_main, DROP COLUMN studio_id;
DROP TABLE anime_external_links;
DROP TABLE anime_tags;

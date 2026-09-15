ALTER TABLE anime_staff DROP CONSTRAINT anime_staff_id_positive;
ALTER TABLE anime_characters DROP CONSTRAINT anime_characters_ids_positive;
DROP INDEX anime_staff_staff_id_idx;
DROP INDEX anime_characters_voice_actor_id_idx;
DROP INDEX anime_characters_character_id_idx;
ALTER TABLE anime_staff DROP COLUMN staff_id;
ALTER TABLE anime_characters DROP COLUMN voice_actor_id, DROP COLUMN character_id;

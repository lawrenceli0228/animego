-- AniList's identities for the people and characters on a title.
--
-- anime_characters and anime_staff have stored names and images since
-- 0001 and never the id behind them: AnimeDetailQuery selected
-- `node { id }` on both connections from the start and the normaliser
-- dropped it on the floor.  Without the id there is no way to say "the
-- same person" across two titles, so there can be no /staff or
-- /character page, no "also voiced" list, and no join to anything
-- outside this table.  Storing it is the whole of this migration.
--
-- Nullable, because the rows written before this migration have none,
-- and the detail path replaces a title's rows wholesale on its next
-- re-fetch -- a row keeps a NULL id only until its title is read again.
-- No backfill: the ids arrive with the ordinary 24h re-fetch and the
-- re-enrich admin surface, at no extra upstream cost.
ALTER TABLE anime_characters
    ADD COLUMN character_id   integer,
    ADD COLUMN voice_actor_id integer;

ALTER TABLE anime_staff
    ADD COLUMN staff_id integer;

-- Reverse lookups: "every title this character / person appears on".
-- Non-unique -- a person is on many titles, which is the point -- and
-- partial, so the rows that predate the column cost nothing to index.
CREATE INDEX anime_characters_character_id_idx ON anime_characters (character_id) WHERE character_id IS NOT NULL;
CREATE INDEX anime_characters_voice_actor_id_idx ON anime_characters (voice_actor_id) WHERE voice_actor_id IS NOT NULL;
CREATE INDEX anime_staff_staff_id_idx ON anime_staff (staff_id) WHERE staff_id IS NOT NULL;

-- Positive when present.  AniList ids are positive integers; a zero here
-- would be a decode default that slipped past the normaliser, and it is
-- better refused at the column than joined on later.
ALTER TABLE anime_characters ADD CONSTRAINT anime_characters_ids_positive CHECK (
    (character_id IS NULL OR character_id > 0) AND (voice_actor_id IS NULL OR voice_actor_id > 0)
);
ALTER TABLE anime_staff ADD CONSTRAINT anime_staff_id_positive CHECK (staff_id IS NULL OR staff_id > 0);

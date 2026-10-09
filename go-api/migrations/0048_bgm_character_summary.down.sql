-- Roll the code back to a build that predates 0048 before running this:
-- cmd/bgmnames writes the column and the character page reads it.  The
-- next import after 0048 is applied again refills it from the dump.
ALTER TABLE bgm_character_map DROP COLUMN IF EXISTS summary;

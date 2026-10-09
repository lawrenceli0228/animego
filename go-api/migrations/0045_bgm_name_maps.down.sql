-- Roll the code back to a build that predates 0045 before running this:
-- /api/anime/:id joins both tables, and cmd/bgmnames writes them.  Nothing
-- else reads them, so dropping them loses only what the next import
-- rebuilds from the dump.
DROP TABLE IF EXISTS bgm_character_map;
DROP TABLE IF EXISTS bgm_person_map;

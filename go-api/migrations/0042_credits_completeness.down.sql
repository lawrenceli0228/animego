-- Roll the code back to a build that predates 0042 before running this.
--
-- That build reads every anime_characters / anime_staff row of a title
-- (its GetAnimeCharactersByID has no LIMIT) and was written when a title
-- never held more than AniList's first page.  The credits sweep has since
-- stored up to 400 of each, so the rows beyond the first page are removed
-- here: left in place, /api/anime/:id would return them all until each
-- title's next refresh rewrote it.
DELETE FROM anime_characters WHERE display_order >= 25;
DELETE FROM anime_staff WHERE display_order >= 25;

ALTER TABLE anime_cache
    DROP COLUMN IF EXISTS staff_checked_at,
    DROP COLUMN IF EXISTS staff_has_more,
    DROP COLUMN IF EXISTS cast_checked_at,
    DROP COLUMN IF EXISTS cast_has_more;

DROP TABLE IF EXISTS anime_character_voices;

DROP INDEX IF EXISTS anime_staff_anime_staff_role_uidx;
DROP INDEX IF EXISTS anime_characters_anime_character_uidx;

-- 0042: every voice of a character, and credit rows a write can address.
--
-- Until now a title kept AniList's first page of characters and of staff
-- (25 each) and, per character, the first Japanese voice actor.  Three
-- things kept it there, and 0042 / 0043 are the schema half of removing
-- each of them:
--
--   1. The detail refresh replaced a title's credit rows wholesale --
--      delete everything, insert page 1 -- so any row beyond page 1 that
--      another writer added would be gone at the next 24h refresh.  A
--      write that keeps the rows it did not fetch has to be able to name
--      the rows it did, hence the two unique indexes here.
--   2. One voice per character, in one language.  anime_character_voices
--      holds every voice role (a childhood voice, a Chinese cast) with the
--      language and the role notes that tell them apart.
--   3. Nothing knew which titles had more than one page, or when the rest
--      was last fetched.  That record is four anime_cache columns, in 0043.
--
-- ★ Deploy order is migrate -> build (minutes) -> recreate, so the binary
-- that predates this file runs against it for a while.  Its credit write
-- is DELETE every row of the title, then INSERT page 1, which none of
-- this obstructs: the new indexes are partial (the rows that predate
-- 0037's ids are not in them), and the new table is one it never reads.
-- The one statement it could trip is an INSERT of a duplicate key within
-- a single page, and AniList's connections carry one edge per
-- (media, character) and per (media, staff, role), so that path does not
-- produce one.
--
-- ★ Lock order.  This file runs as one transaction.  The voices table
-- comes first because its foreign key locks anime_cache (SHARE ROW
-- EXCLUSIVE: anime_cache writes wait, reads do not), and taking that
-- before the credit tables is the order the admin enrichment reset takes
-- them in (anime_cache, then anime_characters); the other way round, a
-- reset arriving mid-migration could deadlock with it.  The anime_cache
-- columns are in 0043 rather than here so the ACCESS EXCLUSIVE lock an
-- ALTER TABLE needs is never queued for while this file holds the credit
-- tables.

-- ---------------------------------------------------------------------------
-- 1. Every voice of a character
-- ---------------------------------------------------------------------------

-- One row per (title, character, voice actor), in the order the site
-- should list them: display_order 0 is the voice the voice_actor_* columns
-- of anime_characters carry (chosen by the title's country of origin --
-- see credits.PrimaryLanguage), the rest follow.
--
-- Keyed to the title rather than to an anime_characters row: that table's
-- key is a surrogate uuid a refresh may replace, and (anime_id,
-- character_id) is only a partial unique index, which a foreign key
-- cannot reference.  The writers keep the two tables in step instead --
-- a write replaces the voices of the characters it wrote and removes any
-- voice whose character row is gone.
--
-- name_full / name_native rather than the _en / _ja of the older tables:
-- the native name of a Chinese voice actor is not Japanese, and this
-- table exists mostly because of them.
CREATE TABLE anime_character_voices (
    anime_id      integer NOT NULL REFERENCES anime_cache(anilist_id) ON DELETE CASCADE,
    character_id  integer NOT NULL,
    staff_id      integer NOT NULL,
    display_order integer NOT NULL,
    -- AniList's languageV2 label: "Japanese", "Chinese", "Korean", ...
    language      text,
    -- "Childhood", "Young", ...; NULL for a character's main voice.
    role_notes    text,
    dub_group     text,
    name_full     text,
    name_native   text,
    image_url     text,
    PRIMARY KEY (anime_id, character_id, staff_id),
    CONSTRAINT anime_character_voices_ids_positive CHECK (character_id > 0 AND staff_id > 0),
    CONSTRAINT anime_character_voices_order_nonneg CHECK (display_order >= 0)
);

-- "Every role this person voiced": the person page's main read.
CREATE INDEX anime_character_voices_staff_id_idx ON anime_character_voices (staff_id);

-- ---------------------------------------------------------------------------
-- 2. Credit rows a write can address
-- ---------------------------------------------------------------------------

-- A title lists a character once, so (title, character) is the key the
-- detail refresh and the sweep upsert on.  Partial, because the rows
-- written before 0037 carry no id; those are deleted by the next write of
-- their title (credits.WriteCast) and never needed a key.
--
-- Duplicates have to go before the index can exist.  None is expected --
-- AniList's connection has one edge per (media, character) -- but a
-- unique index that fails on a stray row would fail the deploy, so the
-- copy AniList listed first (lowest display_order) is kept and the rest
-- removed.
DELETE FROM anime_characters dup
USING anime_characters kept
WHERE dup.anime_id = kept.anime_id
  AND dup.character_id = kept.character_id
  AND (dup.display_order, dup.id) > (kept.display_order, kept.id);

CREATE UNIQUE INDEX anime_characters_anime_character_uidx
    ON anime_characters (anime_id, character_id)
    WHERE character_id IS NOT NULL;

-- A person can be on a title several times, once per role ("Director",
-- "Storyboard (eps 1, 5)"), so the staff key includes the role.  NULLS NOT
-- DISTINCT so a role AniList left empty still identifies one row; without
-- it every write of such a row would add another copy beside it.
DELETE FROM anime_staff dup
USING anime_staff kept
WHERE dup.anime_id = kept.anime_id
  AND dup.staff_id = kept.staff_id
  AND dup.role IS NOT DISTINCT FROM kept.role
  AND (dup.display_order, dup.id) > (kept.display_order, kept.id);

CREATE UNIQUE INDEX anime_staff_anime_staff_role_uidx
    ON anime_staff (anime_id, staff_id, role) NULLS NOT DISTINCT
    WHERE staff_id IS NOT NULL;

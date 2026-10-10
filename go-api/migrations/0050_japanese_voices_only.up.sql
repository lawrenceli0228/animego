-- 0050: Japanese voices only.
--
-- From this release the credits keep Japanese voices and nothing else: the
-- credit documents ask AniList for voiceActorRoles(language: JAPANESE), and
-- internal/credits checks the language again before it writes a row.  What
-- 0042 to 0049 stored is older than that rule -- every Japanese, Chinese
-- and Korean voice of a character, a Chinese or Korean primary voice for a
-- Chinese or Korean production, and a primary in any language for a
-- character with nothing else -- and this file brings it in line, so a
-- title shows the same cast whether or not it has been refreshed since.
-- Data only: no table, column, index or constraint changes.
--
-- In order, in one transaction:
--
--   1. A character row whose voice_actor_* columns name a voice that is not
--      Japanese takes the character's best Japanese voice instead -- the
--      first with no role notes, else the first, in stored order, which is
--      the rule credits.CastFromEdges now follows -- or, with none, has the
--      columns cleared.  voice_actor_cn is cleared either way: it is the
--      Chinese name of whoever the row named before, and the readers take
--      the new person's from bgm_person_map.  A row is found through the
--      voice row of the person it names; a row with no such voice row was
--      written before 0042, when only Japanese voices were stored, and is
--      already right.
--   2. Every voice row that is not Japanese is deleted.  The label is
--      compared case-insensitively; a row with no label is not known to be
--      Japanese and goes too, as the code now drops one.
--   3. display_order is renumbered per character to 0..n-1, the voice of
--      the person the character row names first and the rest in their old
--      order: the invariant ListAnimeCastVoices and the character page read
--      by.  Only rows whose position changes are written.
--   4. The people rows (the AniList profiles of 0044) that steps 1 and 2
--      leave unreferenced are deleted, so their photos leave image_refs and
--      the image warm job stops keeping them.  The candidates are the people
--      this file took a credit from: the staff_id of every voice row step 2
--      deleted and the voice_actor_id of every character row step 1
--      changed.  One is kept while anything still names it -- a voice row,
--      a character row's voice, a staff credit, or a reader's accepted edit
--      (entity_overlays, kind 'person').  A people row that was unreferenced
--      before this file is not a candidate and is left as it is.  Nothing
--      references people by foreign key, and the profiles sweep only asks
--      about people a credit row names (ListPeopleCandidates), so a deleted
--      row does not come back unless a credit names that person again.
--
-- Locks.  The file takes SHARE ROW EXCLUSIVE on the three tables it writes
-- before it reads a row.  Readers (ACCESS SHARE) are not held up.  Writers
-- -- the running binary's detail refresh, credits sweep and profiles sweep,
-- which go on until deploy.sh recreates go-api after the build -- wait for
-- the length of the file instead of interleaving with it: a refresh that
-- prunes and rewrites a title's voices while step 2 deletes and step 3
-- renumbers the same rows can lock them in the other order and deadlock,
-- and the migration losing that would leave it dirty and stop the deploy.
-- The tables are taken in the order the credit writers take them,
-- characters before voices.  The admin enrichment reset deletes a title's
-- voices and characters in one statement, the other way round; it is a
-- manual action, and not one to take during a deploy.
--
-- Timing.  On copies of the credit and profile tables at production's size
-- the file took under a second, and a second run, with nothing left to do,
-- about half that -- measured on PostgreSQL compiled to WebAssembly
-- (PGlite), which is slower than a native server.  That is how long a
-- writer waits.
--
-- The running binary still follows the old rule until it is replaced, so a
-- title it rewrites in that window has voices in other languages again,
-- and its profiles sweep may fetch those people's profiles back.  The 角色
-- tab leaves such voices out; the overview, character and person pages do
-- not, until the title is refreshed.  Run this file again by hand right
-- after deploy.sh recreates go-api.  The statements are safe to repeat, but
-- they only find the people to remove while the voices that name them are
-- still there, which stops being true once the new binary refreshes the
-- title.
--
-- 0050_japanese_voices_only.down.sql restores nothing; see there.
BEGIN;

LOCK TABLE anime_characters, anime_character_voices, people IN SHARE ROW EXCLUSIVE MODE;

-- The people this file takes a credit from (step 4's candidates).
CREATE TEMPORARY TABLE japanese_only_people (anilist_id integer PRIMARY KEY) ON COMMIT DROP;

-- 1. Character rows voiced in another language: their best Japanese voice,
--    or none.  The best voice is looked up per row, through the voice
--    table's primary key, rather than joined from a list of every
--    character's best: the planner cannot estimate how many rows are
--    misvoiced, guesses one, and nests the join, which grows with the
--    square of the real number.
WITH misvoiced AS MATERIALIZED (
    SELECT c.id, c.anime_id, c.character_id, c.voice_actor_id
    FROM anime_characters c
    JOIN anime_character_voices v
      ON v.anime_id = c.anime_id
     AND v.character_id = c.character_id
     AND v.staff_id = c.voice_actor_id
    WHERE lower(btrim(v.language)) IS DISTINCT FROM 'japanese'
),
fixed AS (
    UPDATE anime_characters c
    SET voice_actor_id        = b.staff_id,
        voice_actor_en        = b.name_full,
        voice_actor_ja        = b.name_native,
        voice_actor_image_url = b.image_url,
        voice_actor_cn        = NULL
    FROM misvoiced m
    LEFT JOIN LATERAL (
        SELECT v.staff_id, v.name_full, v.name_native, v.image_url
        FROM anime_character_voices v
        WHERE v.anime_id = m.anime_id
          AND v.character_id = m.character_id
          AND lower(btrim(v.language)) = 'japanese'
        ORDER BY NULLIF(btrim(v.role_notes), '') IS NOT NULL, v.display_order, v.staff_id
        LIMIT 1
    ) b ON true
    WHERE c.id = m.id
    RETURNING m.voice_actor_id
)
INSERT INTO japanese_only_people (anilist_id)
SELECT DISTINCT voice_actor_id FROM fixed
ON CONFLICT DO NOTHING;

-- 2. Every voice that is not Japanese.
WITH dropped AS (
    DELETE FROM anime_character_voices
    WHERE lower(btrim(language)) IS DISTINCT FROM 'japanese'
    RETURNING staff_id
)
INSERT INTO japanese_only_people (anilist_id)
SELECT DISTINCT staff_id FROM dropped
ON CONFLICT DO NOTHING;

-- 3. 0..n-1 per character, the character row's voice first.
WITH ranked AS (
    SELECT v.anime_id, v.character_id, v.staff_id,
           (row_number() OVER (
               PARTITION BY v.anime_id, v.character_id
               ORDER BY CASE WHEN v.staff_id = c.voice_actor_id THEN 0 ELSE 1 END,
                        v.display_order, v.staff_id
           ) - 1)::int AS display_order
    FROM anime_character_voices v
    LEFT JOIN anime_characters c
      ON c.anime_id = v.anime_id AND c.character_id = v.character_id
)
UPDATE anime_character_voices v
SET display_order = r.display_order
FROM ranked r
WHERE v.anime_id = r.anime_id
  AND v.character_id = r.character_id
  AND v.staff_id = r.staff_id
  AND v.display_order <> r.display_order;

-- 4. The profiles of the people steps 1 and 2 left uncredited.
DELETE FROM people p
USING japanese_only_people j
WHERE p.anilist_id = j.anilist_id
  AND NOT EXISTS (SELECT 1 FROM anime_character_voices v WHERE v.staff_id = p.anilist_id)
  AND NOT EXISTS (SELECT 1 FROM anime_characters c WHERE c.voice_actor_id = p.anilist_id)
  AND NOT EXISTS (SELECT 1 FROM anime_staff s WHERE s.staff_id = p.anilist_id)
  AND NOT EXISTS (
      SELECT 1 FROM entity_overlays o
      WHERE o.kind = 'person' AND o.entity_id = p.anilist_id
  );

COMMIT;

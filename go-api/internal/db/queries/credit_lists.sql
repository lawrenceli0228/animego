-- credit_lists.sql — the detail page's 角色 and 制作 tabs: every character,
-- voice and staff credit a title stores, for /api/anime/:id/characters,
-- /api/anime/:id/staff and /api/anime/:id/credit-counts
-- (internal/anime/credit_lists.go).
--
-- Read-only, and only from our own tables: these endpoints never go to
-- AniList, so a title we do not hold is a 404 rather than a fetch.
--
-- Each query reads a whole title.  The credits sweep keeps at most 400
-- characters and 400 staff credits a title (internal/queue), and the
-- handler filters, counts and pages that list in Go, so a reader typing
-- into the search box re-reads a cached copy rather than the tables.  The
-- LIMITs are a ceiling on a table no writer is meant to fill past that,
-- not a page size.

-- name: GetAnimeCreditsHead :one
-- The title's existence and two facts about it.  The country of origin
-- picks the default dub language, the same way credits.PrimaryLanguage
-- picks the voice the character rows carry.  detail_fetched says whether
-- the credit tables have been filled at all: a row a listing wrote
-- (seasonal, search, warm_season) has none of them until the next
-- /api/anime/:id fetches its detail, so its empty lists are "not yet",
-- not "nobody" -- the same distinction isStale draws (detail.go).
SELECT country_of_origin, (detail_fetched_at IS NOT NULL)::boolean AS detail_fetched
FROM anime_cache
WHERE anilist_id = $1;

-- name: GetAnimeCreditCounts :one
-- The two numbers the tab bar shows, without reading the lists: every
-- overview render asks for them.  ErrNoRows for a title we do not hold;
-- detail_fetched as in GetAnimeCreditsHead.
--
-- Characters are rows, a row with no AniList id included.  Staff are
-- people, not credits: a person is their AniList id, or for a row written
-- before 0037 their names -- the identity buildStaffList counts by
-- (chr(31) is its separator too), so the staff tab and the number that
-- led to it agree.
SELECT
    (SELECT count(*) FROM anime_characters c WHERE c.anime_id = a.anilist_id)::int AS characters,
    (SELECT count(DISTINCT COALESCE(
                'id:' || s.staff_id::text,
                'name:' || COALESCE(s.name_ja, '') || chr(31) || COALESCE(s.name_en, '')))
       FROM anime_staff s WHERE s.anime_id = a.anilist_id)::int AS staff,
    (a.detail_fetched_at IS NOT NULL)::boolean AS detail_fetched
FROM anime_cache a
WHERE a.anilist_id = $1;

-- name: ListAnimeCastCharacters :many
-- Every character on the title in AniList's order ([ROLE, RELEVANCE, ID]
-- -- display_order), with the Chinese names GetAnimeCharactersByID uses:
-- Bangumi's match first (0045), then whatever the row itself holds.
--
-- The voice_actor_* columns ride along for the rows anime_character_voices
-- has nothing for: a row written before 0042, or one with no character id,
-- carries its only voice here.
SELECT
    c.character_id,
    c.role,
    c.name_en,
    c.name_ja,
    COALESCE(cm.name_cn, c.name_cn) AS name_cn,
    c.image_url,
    c.voice_actor_id,
    c.voice_actor_en,
    c.voice_actor_ja,
    COALESCE(pm.name_cn, c.voice_actor_cn) AS voice_actor_cn,
    c.voice_actor_image_url
FROM anime_characters c
LEFT JOIN bgm_character_map cm ON cm.anilist_id = c.character_id
LEFT JOIN bgm_person_map pm ON pm.anilist_id = c.voice_actor_id
WHERE c.anime_id = $1
ORDER BY c.display_order, c.id
LIMIT 1000;

-- name: ListAnimeCastVoices :many
-- Every voice the title stores (0042), each character's in its stored
-- order: display_order 0 is the voice its character row carries, the
-- title's own language comes next, then Japanese, Chinese and Korean.
-- name_cn is Bangumi's, by the person's AniList id.  staff_id breaks a
-- tie, which the detail refresh and the credits sweep upserting one title
-- at once can leave, so the first voice is always the same one.
SELECT
    v.character_id,
    v.staff_id,
    v.language,
    v.role_notes,
    v.dub_group,
    v.name_full,
    v.name_native,
    pm.name_cn,
    v.image_url
FROM anime_character_voices v
LEFT JOIN bgm_person_map pm ON pm.anilist_id = v.staff_id
WHERE v.anime_id = $1
ORDER BY v.character_id, v.display_order, v.staff_id
LIMIT 8000;

-- name: ListAnimeStaffCredits :many
-- Every staff credit on the title, one row per person per role, in
-- AniList's order ([RELEVANCE, ID] -- display_order).  name_cn is
-- Bangumi's (0045); the detail endpoint has no field for it, this one
-- does.
SELECT
    s.staff_id,
    s.role,
    s.name_en,
    s.name_ja,
    pm.name_cn,
    s.image_url
FROM anime_staff s
LEFT JOIN bgm_person_map pm ON pm.anilist_id = s.staff_id
WHERE s.anime_id = $1
ORDER BY s.display_order, s.id
LIMIT 1000;

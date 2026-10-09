-- people_pages.sql — the person and character pages (internal/people).
-- Database only; adult titles are filtered here, where credits are read,
-- and a profile row counts only once AniList returned it (fetched_at).

-- name: GetPersonIdentity :one
-- A person's AniList profile, if the sweep has fetched one, and Bangumi's
-- match, if the import made one.  Always one row -- the id is selected from
-- a one-row VALUES list and both sources are LEFT JOINed onto it -- so "no
-- profile" and "no match" are NULL columns rather than two error paths.
-- has_profile tells a fetched profile from an absent one, since every
-- profile column can be NULL on a real profile too.
--
-- The alternative names are not read.  For a voice actor AniList's list
-- carries the pseudonyms they work under elsewhere, adult games included,
-- and a person page is not the place to join those to their name.
SELECT
    p.name_full,
    p.name_native,
    p.language,
    p.image_large,
    p.primary_occupations,
    p.gender,
    p.birth_year,
    p.birth_month,
    p.birth_day,
    p.death_year,
    p.death_month,
    p.death_day,
    p.age,
    p.years_active,
    p.home_town,
    p.blood_type,
    p.site_url,
    (p.anilist_id IS NOT NULL)::boolean AS has_profile,
    m.bgm_id,
    m.name_cn
FROM (VALUES (sqlc.arg(id)::int)) AS k (id)
LEFT JOIN people p ON p.anilist_id = k.id AND p.fetched_at IS NOT NULL
LEFT JOIN bgm_person_map m ON m.anilist_id = k.id;

-- name: ListPersonVoiceRoles :many
-- Every role a person voiced on a non-adult title, one row per (title,
-- character, language, notes).  A page exists for an id the credits name:
-- they are its content, and the profile (0044) and the Bangumi match
-- (0045) only add to it.  Adult titles are stored like every other row and
-- left out where they are read: not listed, not counted, and an id
-- credited only on adult titles has no page.
--
-- Two sources.  anime_character_voices (0042) holds every voice of a
-- character; a title last written before 0042 has none there and carries
-- its one voice on anime_characters.voice_actor_id instead.  That voice is
-- taken only where the title has no anime_character_voices row for the
-- pair, and it is labelled Japanese because it is one: the query that
-- wrote it asked AniList for voiceActors(language: JAPANESE).
--
-- The person's own name and image come with each row as that credit
-- stored them: they are the page's name and photo when the profile sweep
-- has not reached this id.
WITH roles AS (
    SELECT v.anime_id, v.character_id, v.language, v.role_notes,
           v.name_full AS person_full, v.name_native AS person_native, v.image_url AS person_image
    FROM anime_character_voices v
    WHERE v.staff_id = sqlc.arg(staff_id)::int
    UNION ALL
    SELECT c.anime_id, c.character_id, 'Japanese'::text, NULL::text,
           c.voice_actor_en, c.voice_actor_ja, c.voice_actor_image_url
    FROM anime_characters c
    WHERE c.voice_actor_id = sqlc.arg(staff_id)::int
      AND c.character_id IS NOT NULL
      AND NOT EXISTS (
          SELECT 1 FROM anime_character_voices v
          WHERE v.anime_id = c.anime_id
            AND v.character_id = c.character_id
            AND v.staff_id = c.voice_actor_id
      )
)
SELECT
    r.anime_id,
    r.character_id::int AS character_id,
    r.language,
    r.role_notes,
    r.person_full,
    r.person_native,
    r.person_image,
    c.role,
    c.display_order AS character_order,
    c.name_en AS character_full,
    c.name_ja AS character_native,
    c.image_url AS character_image,
    cm.name_cn AS character_cn,
    ch.image_large AS character_image_large,
    a.title_romaji,
    a.title_english,
    a.title_native,
    a.title_chinese,
    a.title_hant,
    a.title_hant_seo,
    a.cover_image_url,
    a.format,
    a.season_year,
    a.start_date,
    a.popularity,
    a.poster_accent
FROM roles r
JOIN anime_characters c ON c.anime_id = r.anime_id AND c.character_id = r.character_id
JOIN anime_cache a ON a.anilist_id = r.anime_id
LEFT JOIN bgm_character_map cm ON cm.anilist_id = r.character_id
LEFT JOIN characters ch ON ch.anilist_id = r.character_id AND ch.fetched_at IS NOT NULL
WHERE NOT a.is_adult
ORDER BY r.anime_id, c.display_order, r.character_id;

-- name: ListPersonStaffCredits :many
-- Every production credit a person holds on a non-adult title, one row
-- per (title, role) in the order AniList lists the title's staff.  The
-- person's name and image as the credit stored them ride along, for the
-- reason ListPersonVoiceRoles gives.
SELECT
    s.anime_id,
    s.role,
    s.name_en AS person_full,
    s.name_ja AS person_native,
    s.image_url AS person_image,
    a.title_romaji,
    a.title_english,
    a.title_native,
    a.title_chinese,
    a.title_hant,
    a.title_hant_seo,
    a.cover_image_url,
    a.format,
    a.season_year,
    a.start_date,
    a.popularity,
    a.poster_accent
FROM anime_staff s
JOIN anime_cache a ON a.anilist_id = s.anime_id
WHERE s.staff_id = sqlc.arg(staff_id)::int
  AND NOT a.is_adult
ORDER BY s.anime_id, s.display_order, s.id;

-- name: GetCharacterIdentity :one
-- GetPersonIdentity for a character.  The spoiler aliases are not read:
-- the page does not show them, and an answer that carries them puts them
-- in the page source.
SELECT
    ch.name_full,
    ch.name_native,
    ch.name_alternative,
    ch.image_large,
    ch.description,
    ch.gender,
    ch.birth_year,
    ch.birth_month,
    ch.birth_day,
    ch.age,
    ch.blood_type,
    ch.site_url,
    (ch.anilist_id IS NOT NULL)::boolean AS has_profile,
    m.bgm_id,
    m.name_cn,
    m.summary AS bgm_summary
FROM (VALUES (sqlc.arg(id)::int)) AS k (id)
LEFT JOIN characters ch ON ch.anilist_id = k.id AND ch.fetched_at IS NOT NULL
LEFT JOIN bgm_character_map m ON m.anilist_id = k.id;

-- name: ListCharacterAppearances :many
-- Every non-adult title a character is listed on, with the character's
-- role there and the name and image that title's credit stored.
SELECT
    c.anime_id,
    c.role,
    c.name_en,
    c.name_ja,
    c.image_url,
    a.title_romaji,
    a.title_english,
    a.title_native,
    a.title_chinese,
    a.title_hant,
    a.title_hant_seo,
    a.cover_image_url,
    a.format,
    a.season_year,
    a.start_date,
    a.popularity,
    a.poster_accent
FROM anime_characters c
JOIN anime_cache a ON a.anilist_id = c.anime_id
WHERE c.character_id = sqlc.arg(character_id)::int
  AND NOT a.is_adult
ORDER BY c.anime_id;

-- name: ListCharacterVoices :many
-- Every voice of a character on its non-adult titles, one row per (title,
-- voice): the two sources ListPersonVoiceRoles reads, from the character's
-- side.  A title's anime_characters voice is taken only when the title has
-- no anime_character_voices row for the character at all.  The voice's
-- Chinese name and profile photo come from the Bangumi match and the
-- profile, where they exist.
--
-- Reached through the character's anime_characters rows (indexed on
-- character_id) and then the voices' primary key (anime_id, character_id,
-- ...): anime_character_voices has no index of its own on character_id, and
-- filtering it by that column directly is a scan of the whole table.  The
-- credit writers keep the two tables in step, so the voices this reaches
-- are all of them.
WITH apps AS (
    SELECT c.anime_id, c.character_id, c.voice_actor_id,
           c.voice_actor_en, c.voice_actor_ja, c.voice_actor_image_url
    FROM anime_characters c
    WHERE c.character_id = sqlc.arg(character_id)::int
),
voices AS (
    SELECT v.anime_id, v.staff_id, v.language, v.role_notes, v.display_order,
           v.name_full, v.name_native, v.image_url
    FROM apps ap
    JOIN anime_character_voices v ON v.anime_id = ap.anime_id AND v.character_id = ap.character_id
    UNION ALL
    SELECT ap.anime_id, ap.voice_actor_id::int, 'Japanese'::text, NULL::text, 0,
           ap.voice_actor_en, ap.voice_actor_ja, ap.voice_actor_image_url
    FROM apps ap
    WHERE ap.voice_actor_id IS NOT NULL
      AND NOT EXISTS (
          SELECT 1 FROM anime_character_voices v
          WHERE v.anime_id = ap.anime_id AND v.character_id = ap.character_id
      )
)
SELECT
    v.anime_id,
    v.staff_id::int AS staff_id,
    v.language,
    v.role_notes,
    v.display_order::int AS display_order,
    v.name_full,
    v.name_native,
    v.image_url,
    pm.name_cn,
    p.image_large,
    a.popularity
FROM voices v
JOIN anime_cache a ON a.anilist_id = v.anime_id
LEFT JOIN bgm_person_map pm ON pm.anilist_id = v.staff_id
LEFT JOIN people p ON p.anilist_id = v.staff_id AND p.fetched_at IS NOT NULL
WHERE NOT a.is_adult
ORDER BY v.anime_id, v.display_order, v.staff_id;

-- name: ListPeopleSitemapShard :many
-- The people whose page is indexed, in one modulo shard: credited on at
-- least min_voice_works non-adult titles as a voice, or min_staff_works as
-- staff.  The counts are of distinct titles, read from the same sources
-- with the same joins as ListPersonVoiceRoles and ListPersonStaffCredits,
-- so this list and the page's own `indexable` cannot disagree.  The
-- thresholds are internal/people's constants, passed in.
--
-- updated_at is the latest of the profile fetch, the last accepted edit
-- (entity_overlays) and the last write of any title the person is
-- credited on: the page is built from those rows and from nothing else.
-- An edit changes no count, so it cannot move a person across the
-- threshold.
WITH credits AS (
    SELECT v.staff_id AS id, v.anime_id, true AS voiced
    FROM anime_character_voices v
    JOIN anime_characters c ON c.anime_id = v.anime_id AND c.character_id = v.character_id
    UNION
    SELECT c.voice_actor_id, c.anime_id, true
    FROM anime_characters c
    WHERE c.voice_actor_id IS NOT NULL AND c.character_id IS NOT NULL
    UNION
    SELECT s.staff_id, s.anime_id, false
    FROM anime_staff s
    WHERE s.staff_id IS NOT NULL
),
counted AS (
    SELECT cr.id,
           count(*) FILTER (WHERE cr.voiced) AS voice_works,
           count(*) FILTER (WHERE NOT cr.voiced) AS staff_works,
           max(a.updated_at) AS updated_at
    FROM credits cr
    JOIN anime_cache a ON a.anilist_id = cr.anime_id
    WHERE NOT a.is_adult
      AND cr.id % sqlc.arg(shard_count)::int = sqlc.arg(shard_index)::int
    GROUP BY cr.id
)
SELECT
    c.id::int AS anilist_id,
    GREATEST(c.updated_at, p.fetched_at, o.updated_at)::timestamptz AS updated_at
FROM counted c
LEFT JOIN people p ON p.anilist_id = c.id AND p.fetched_at IS NOT NULL
LEFT JOIN entity_overlays o ON o.kind = 'person' AND o.entity_id = c.id
WHERE c.voice_works >= sqlc.arg(min_voice_works)::int
   OR c.staff_works >= sqlc.arg(min_staff_works)::int
ORDER BY c.id;

-- name: ListCharactersSitemapShard :many
-- The characters whose page is indexed, in one modulo shard: a lead
-- (MAIN) on at least one non-adult title, with a Chinese name.  Both are
-- read the way the page reads them: the accepted edits first
-- (entity_overlays, 0047 -- a role per title, a Chinese name), then
-- Bangumi's name and the credit's role, so an edit that gives a lead its
-- Chinese name lists the page and the page says index, together.
-- updated_at as ListPeopleSitemapShard has it.
SELECT
    c.character_id::int AS anilist_id,
    GREATEST(max(a.updated_at), max(ch.fetched_at), max(o.updated_at))::timestamptz AS updated_at
FROM anime_characters c
JOIN anime_cache a ON a.anilist_id = c.anime_id
LEFT JOIN bgm_character_map m ON m.anilist_id = c.character_id
LEFT JOIN characters ch ON ch.anilist_id = c.character_id AND ch.fetched_at IS NOT NULL
LEFT JOIN entity_overlays o ON o.kind = 'character' AND o.entity_id = c.character_id
WHERE c.character_id IS NOT NULL
  AND NOT a.is_adult
  AND COALESCE(o.data->>'nameCn', m.name_cn) IS NOT NULL
  AND c.character_id % sqlc.arg(shard_count)::int = sqlc.arg(shard_index)::int
GROUP BY c.character_id
HAVING bool_or(COALESCE(o.data->'roles'->>(c.anime_id::text), c.role) = 'MAIN')
ORDER BY c.character_id;

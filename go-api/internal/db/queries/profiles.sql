-- Profiles: AniList's people and characters (migration 0044), written by
-- the profiles sweep (queue/profiles.go), one transaction per batch of up
-- to fifty ids: an upsert per profile AniList returned, then one stamp for
-- the ids it did not.

-- name: ListPeopleCandidates :many
-- The AniList Staff ids the profiles sweep should ask about next: every
-- person a credit row names -- a staff credit (anime_staff.staff_id), a
-- character's primary voice (anime_characters.voice_actor_id) or any of
-- its voices (anime_character_voices.staff_id) -- in two tiers.
--
--   1. Never asked (no people row), the most visible first: by the highest
--      popularity among the titles that credit them, then by how many
--      credit rows name them, then by id.  queue/profiles.go says why
--      popularity and not the credit count leads.
--   2. Asked before, last asked longer ago than stale_after, and still
--      credited somewhere, oldest stamp first.  A person no credit names
--      any more is not asked about again; their row stays as it is.
--
-- Each tier is capped at row_limit before the two are put together, so
-- the second is an index scan that stops early whatever the first holds.
-- Adult titles are not excluded: their credits are stored like every
-- other row and filtered where they are read, and so are these.
WITH refs AS (
    SELECT s.staff_id AS id, s.anime_id FROM anime_staff s WHERE s.staff_id IS NOT NULL
    UNION ALL
    SELECT c.voice_actor_id, c.anime_id FROM anime_characters c WHERE c.voice_actor_id IS NOT NULL
    UNION ALL
    SELECT v.staff_id, v.anime_id FROM anime_character_voices v
),
never_asked AS (
    SELECT r.id, max(a.popularity) AS popularity, count(*) AS credits
    FROM refs r
    JOIN anime_cache a ON a.anilist_id = r.anime_id
    WHERE NOT EXISTS (SELECT 1 FROM people p WHERE p.anilist_id = r.id)
    GROUP BY r.id
    ORDER BY max(a.popularity) DESC NULLS LAST, count(*) DESC, r.id
    LIMIT sqlc.arg(row_limit)::int
),
due AS (
    SELECT p.anilist_id AS id, p.checked_at
    FROM people p
    WHERE p.checked_at < now() - sqlc.arg(stale_after)::interval
      AND (EXISTS (SELECT 1 FROM anime_staff s WHERE s.staff_id = p.anilist_id)
           OR EXISTS (SELECT 1 FROM anime_characters c WHERE c.voice_actor_id = p.anilist_id)
           OR EXISTS (SELECT 1 FROM anime_character_voices v WHERE v.staff_id = p.anilist_id))
    ORDER BY p.checked_at, p.anilist_id
    LIMIT sqlc.arg(row_limit)::int
)
SELECT ranked.id::int AS anilist_id
FROM (
    SELECT n.id, 1 AS tier,
           row_number() OVER (ORDER BY n.popularity DESC NULLS LAST, n.credits DESC, n.id) AS pos
    FROM never_asked n
    UNION ALL
    SELECT d.id, 2 AS tier,
           row_number() OVER (ORDER BY d.checked_at, d.id) AS pos
    FROM due d
) ranked
ORDER BY ranked.tier, ranked.pos
LIMIT sqlc.arg(row_limit)::int;

-- name: ListCharacterCandidates :many
-- ListPeopleCandidates for characters: every character a title lists
-- (anime_characters.character_id), in the same two tiers and the same
-- order.  anime_character_voices names no character that anime_characters
-- does not (the credit writers keep the two in step), so it adds nothing.
WITH never_asked AS (
    SELECT c.character_id AS id, max(a.popularity) AS popularity, count(*) AS credits
    FROM anime_characters c
    JOIN anime_cache a ON a.anilist_id = c.anime_id
    WHERE c.character_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM characters p WHERE p.anilist_id = c.character_id)
    GROUP BY c.character_id
    ORDER BY max(a.popularity) DESC NULLS LAST, count(*) DESC, c.character_id
    LIMIT sqlc.arg(row_limit)::int
),
due AS (
    SELECT p.anilist_id AS id, p.checked_at
    FROM characters p
    WHERE p.checked_at < now() - sqlc.arg(stale_after)::interval
      AND EXISTS (SELECT 1 FROM anime_characters c WHERE c.character_id = p.anilist_id)
    ORDER BY p.checked_at, p.anilist_id
    LIMIT sqlc.arg(row_limit)::int
)
SELECT ranked.id::int AS anilist_id
FROM (
    SELECT n.id, 1 AS tier,
           row_number() OVER (ORDER BY n.popularity DESC NULLS LAST, n.credits DESC, n.id) AS pos
    FROM never_asked n
    UNION ALL
    SELECT d.id, 2 AS tier,
           row_number() OVER (ORDER BY d.checked_at, d.id) AS pos
    FROM due d
) ranked
ORDER BY ranked.tier, ranked.pos
LIMIT sqlc.arg(row_limit)::int;

-- name: UpsertPerson :exec
-- One person as AniList returned them: every profile column replaced, both
-- stamps set to the fetch, the absence (if any) cleared.
--
-- Replaced, not COALESCEd.  The facts sweep keeps a stored value when
-- AniList sends null, because anime_cache has other writers and a null
-- across the whole catalogue at once would have no second source to be
-- restored from.  A profile has one writer and one source: the row is
-- AniList's as of fetched_at, so a description AniList removed is removed
-- here too.  The lists are COALESCEd only because a nil Go slice arrives
-- as NULL, and NULL is not an empty list.
INSERT INTO people (
    anilist_id, name_full, name_native, name_alternative, language,
    image_large, image_medium, description, primary_occupations, gender,
    birth_year, birth_month, birth_day, death_year, death_month, death_day,
    age, years_active, home_town, blood_type, favourites, site_url,
    fetched_at, checked_at, absent_since
) VALUES (
    sqlc.arg(anilist_id), sqlc.narg(name_full), sqlc.narg(name_native),
    COALESCE(sqlc.narg(name_alternative)::text[], '{}'), sqlc.narg(language),
    sqlc.narg(image_large), sqlc.narg(image_medium), sqlc.narg(description),
    COALESCE(sqlc.narg(primary_occupations)::text[], '{}'), sqlc.narg(gender),
    sqlc.narg(birth_year), sqlc.narg(birth_month), sqlc.narg(birth_day),
    sqlc.narg(death_year), sqlc.narg(death_month), sqlc.narg(death_day),
    sqlc.narg(age), COALESCE(sqlc.narg(years_active)::int[], '{}'),
    sqlc.narg(home_town), sqlc.narg(blood_type), sqlc.narg(favourites), sqlc.narg(site_url),
    sqlc.arg(fetched_at)::timestamptz, sqlc.arg(fetched_at)::timestamptz, NULL
)
ON CONFLICT (anilist_id) DO UPDATE SET
    name_full           = EXCLUDED.name_full,
    name_native         = EXCLUDED.name_native,
    name_alternative    = EXCLUDED.name_alternative,
    language            = EXCLUDED.language,
    image_large         = EXCLUDED.image_large,
    image_medium        = EXCLUDED.image_medium,
    description         = EXCLUDED.description,
    primary_occupations = EXCLUDED.primary_occupations,
    gender              = EXCLUDED.gender,
    birth_year          = EXCLUDED.birth_year,
    birth_month         = EXCLUDED.birth_month,
    birth_day           = EXCLUDED.birth_day,
    death_year          = EXCLUDED.death_year,
    death_month         = EXCLUDED.death_month,
    death_day           = EXCLUDED.death_day,
    age                 = EXCLUDED.age,
    years_active        = EXCLUDED.years_active,
    home_town           = EXCLUDED.home_town,
    blood_type          = EXCLUDED.blood_type,
    favourites          = EXCLUDED.favourites,
    site_url            = EXCLUDED.site_url,
    fetched_at          = EXCLUDED.fetched_at,
    checked_at          = EXCLUDED.checked_at,
    absent_since        = NULL;

-- name: UpsertCharacter :exec
-- UpsertPerson for characters.
INSERT INTO characters (
    anilist_id, name_full, name_native, name_alternative, name_alternative_spoiler,
    image_large, image_medium, description, gender,
    birth_year, birth_month, birth_day, age, blood_type, favourites, site_url,
    fetched_at, checked_at, absent_since
) VALUES (
    sqlc.arg(anilist_id), sqlc.narg(name_full), sqlc.narg(name_native),
    COALESCE(sqlc.narg(name_alternative)::text[], '{}'),
    COALESCE(sqlc.narg(name_alternative_spoiler)::text[], '{}'),
    sqlc.narg(image_large), sqlc.narg(image_medium), sqlc.narg(description), sqlc.narg(gender),
    sqlc.narg(birth_year), sqlc.narg(birth_month), sqlc.narg(birth_day),
    sqlc.narg(age), sqlc.narg(blood_type), sqlc.narg(favourites), sqlc.narg(site_url),
    sqlc.arg(fetched_at)::timestamptz, sqlc.arg(fetched_at)::timestamptz, NULL
)
ON CONFLICT (anilist_id) DO UPDATE SET
    name_full                = EXCLUDED.name_full,
    name_native              = EXCLUDED.name_native,
    name_alternative         = EXCLUDED.name_alternative,
    name_alternative_spoiler = EXCLUDED.name_alternative_spoiler,
    image_large              = EXCLUDED.image_large,
    image_medium             = EXCLUDED.image_medium,
    description              = EXCLUDED.description,
    gender                   = EXCLUDED.gender,
    birth_year               = EXCLUDED.birth_year,
    birth_month              = EXCLUDED.birth_month,
    birth_day                = EXCLUDED.birth_day,
    age                      = EXCLUDED.age,
    blood_type               = EXCLUDED.blood_type,
    favourites               = EXCLUDED.favourites,
    site_url                 = EXCLUDED.site_url,
    fetched_at               = EXCLUDED.fetched_at,
    checked_at               = EXCLUDED.checked_at,
    absent_since             = NULL;

-- name: StampPeopleChecked :exec
-- Stamps ids the sweep asked about and has no profile to write for.
--
-- absent: the ask succeeded and these ids were not in the answer -- AniList
-- deleted them, or merged them into another id.  absent_since is set the
-- first time and kept after, so it says since when.  Not absent: the ask
-- failed, checked_at arrives back-dated (see queue/profiles.go), and
-- nothing else moves.  Either way a stored profile and its fetched_at are
-- left alone, and an id with no row gets a stamp-only one.
INSERT INTO people (anilist_id, checked_at, absent_since)
SELECT DISTINCT ids.id, sqlc.arg(checked_at)::timestamptz,
       CASE WHEN sqlc.arg(absent)::boolean THEN sqlc.arg(checked_at)::timestamptz END
FROM unnest(sqlc.arg(ids)::int[]) AS ids(id)
ON CONFLICT (anilist_id) DO UPDATE SET
    checked_at   = EXCLUDED.checked_at,
    absent_since = CASE WHEN sqlc.arg(absent)::boolean
                        THEN COALESCE(people.absent_since, EXCLUDED.checked_at)
                        ELSE people.absent_since
                   END;

-- name: StampCharactersChecked :exec
-- StampPeopleChecked for characters.
INSERT INTO characters (anilist_id, checked_at, absent_since)
SELECT DISTINCT ids.id, sqlc.arg(checked_at)::timestamptz,
       CASE WHEN sqlc.arg(absent)::boolean THEN sqlc.arg(checked_at)::timestamptz END
FROM unnest(sqlc.arg(ids)::int[]) AS ids(id)
ON CONFLICT (anilist_id) DO UPDATE SET
    checked_at   = EXCLUDED.checked_at,
    absent_since = CASE WHEN sqlc.arg(absent)::boolean
                        THEN COALESCE(characters.absent_since, EXCLUDED.checked_at)
                        ELSE characters.absent_since
                   END;

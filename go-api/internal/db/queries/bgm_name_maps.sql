-- bgm_name_maps.sql — cmd/bgmnames: which Bangumi person or character each
-- AniList id is, and its simplified Chinese name (migration 0045).  The
-- matching rules are internal/bgmnames'.

-- name: ListBgmBoundTitles :many
-- Every title bound to a Bangumi subject.  The binding is not trusted:
-- the import matches names inside the title, and a wrong binding matches
-- nothing.
SELECT anilist_id, bgm_id::int AS bgm_id
FROM anime_cache
WHERE bgm_id IS NOT NULL
ORDER BY anilist_id;

-- name: ListBgmCastVoices :many
-- Every voice on every bound title, with the native names AniList stores
-- for the character and for the person.  Two sources, because a row
-- written before 0042 has its primary voice on anime_characters and none
-- in anime_character_voices; UNION removes the primary voice where both
-- hold it.
SELECT v.anime_id, v.character_id, c.name_ja AS character_native,
       v.staff_id, v.name_native AS staff_native
FROM anime_character_voices v
JOIN anime_characters c ON c.anime_id = v.anime_id AND c.character_id = v.character_id
JOIN anime_cache a ON a.anilist_id = v.anime_id
WHERE a.bgm_id IS NOT NULL
UNION
SELECT c.anime_id, c.character_id::int, c.name_ja,
       c.voice_actor_id::int, c.voice_actor_ja
FROM anime_characters c
JOIN anime_cache a ON a.anilist_id = c.anime_id
WHERE a.bgm_id IS NOT NULL
  AND c.character_id IS NOT NULL
  AND c.voice_actor_id IS NOT NULL;

-- name: ListBgmCreditedStaff :many
-- Every staff credit on every bound title, once per person and title
-- however many roles they hold there.
SELECT DISTINCT s.anime_id, s.staff_id::int AS staff_id, s.name_ja AS staff_native
FROM anime_staff s
JOIN anime_cache a ON a.anilist_id = s.anime_id
WHERE a.bgm_id IS NOT NULL
  AND s.staff_id IS NOT NULL;

-- name: LockBgmNameMaps :exec
-- Serialises imports: a second run started while one is writing waits for
-- it (the lock ends with the transaction) instead of interleaving its
-- deletes and inserts with the first one's.  Readers are not affected.
SELECT pg_advisory_xact_lock(hashtext('bgm_name_maps'));

-- name: ListBgmPersonMap :many
SELECT anilist_id, bgm_id, name_cn FROM bgm_person_map;

-- name: ListBgmCharacterMap :many
SELECT anilist_id, bgm_id, name_cn FROM bgm_character_map;

-- name: DeleteBgmPersonMap :exec
-- The rows an import replaces or no longer finds.  Deleted before the
-- inserts, so a Bangumi id moving between two AniList ids in one run never
-- meets the unique index twice.
DELETE FROM bgm_person_map WHERE anilist_id = ANY(sqlc.arg(ids)::int[]);

-- name: DeleteBgmCharacterMap :exec
DELETE FROM bgm_character_map WHERE anilist_id = ANY(sqlc.arg(ids)::int[]);

-- name: InsertBgmPersonMap :copyfrom
-- The rows an import adds or replaces, in one COPY.
INSERT INTO bgm_person_map (anilist_id, bgm_id, name_cn, source, matched_at)
VALUES ($1, $2, $3, $4, $5);

-- name: InsertBgmCharacterMap :copyfrom
INSERT INTO bgm_character_map (anilist_id, bgm_id, name_cn, source, matched_at)
VALUES ($1, $2, $3, $4, $5);

-- 0045: which Bangumi person or character each AniList id is, and the
-- simplified Chinese name Bangumi gives it.
--
-- Filled by cmd/bgmnames from the Bangumi Archive dump (internal/bgmnames
-- has the matching rules): a voice actor, a staff member or a character
-- is matched by native name inside a title bound to a Bangumi subject,
-- never across the whole of Bangumi.  /api/anime/:id reads the names into
-- the nameCn and voiceActorCn fields it has always had.
--
-- Keyed by AniList id, one table per kind, like people and characters
-- (0044), but apart from them:
--
--   - those rows belong to the profiles sweep, whose candidate query reads
--     "a row exists" as "AniList was asked about this id".  A row written
--     here for an id the sweep has not reached would read as asked;
--   - this mapping is Bangumi's, and each import replaces it with what
--     that week's dump supports -- a match the new dump no longer supports
--     is deleted -- without touching AniList's data;
--   - the read path works whether or not the profiles sweep has run.
--
-- bgm_id is unique: one Bangumi id is one AniList id, as the importer's
-- conflict rule already ensures (an id that would map two ways is written
-- neither way); the index makes the database say so too.  name_cn is NULL
-- when Bangumi gives the match no Chinese name: the match is still kept.
-- source names the dump the row came from; matched_at is when the pair,
-- as stored, was first written -- a weekly import that finds the same
-- pair leaves both alone.
--
-- Locks.  Two new tables and nothing else: no foreign key (the ids are
-- AniList's and Bangumi's, not rows of ours), no index on an existing
-- table.  The detail read joins these tables by primary key, 25 rows a
-- request.  TestMigration0045_PG applies this file while the credit
-- tables and 0044's tables are locked.  The tables start empty; the
-- import fills them.

CREATE TABLE bgm_person_map (
    anilist_id integer PRIMARY KEY,
    bgm_id     integer NOT NULL,
    name_cn    text,
    source     text NOT NULL,
    matched_at timestamptz NOT NULL,
    CONSTRAINT bgm_person_map_ids_positive CHECK (anilist_id > 0 AND bgm_id > 0),
    CONSTRAINT bgm_person_map_name_cn_not_blank CHECK (name_cn IS NULL OR btrim(name_cn) <> '')
);

CREATE UNIQUE INDEX bgm_person_map_bgm_id_uidx ON bgm_person_map (bgm_id);

CREATE TABLE bgm_character_map (
    anilist_id integer PRIMARY KEY,
    bgm_id     integer NOT NULL,
    name_cn    text,
    source     text NOT NULL,
    matched_at timestamptz NOT NULL,
    CONSTRAINT bgm_character_map_ids_positive CHECK (anilist_id > 0 AND bgm_id > 0),
    CONSTRAINT bgm_character_map_name_cn_not_blank CHECK (name_cn IS NULL OR btrim(name_cn) <> '')
);

CREATE UNIQUE INDEX bgm_character_map_bgm_id_uidx ON bgm_character_map (bgm_id);

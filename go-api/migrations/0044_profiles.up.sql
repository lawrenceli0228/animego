-- 0044: AniList's profiles of the people and characters the site lists.
--
-- Since 0037 the credit tables carry AniList's id for every person and
-- character on a title -- anime_staff.staff_id, anime_characters'
-- character_id and voice_actor_id, and since 0042 every voice in
-- anime_character_voices -- and beside each id only what a credit line
-- shows: a name and an image.  A person or character page needs the
-- profile behind the id: the other names, the description, the birthday,
-- and for a person their occupations, years active and home town.  These
-- two tables hold it, one row per AniList id, from AniList's Staff and
-- Character types; the profiles sweep (queue/profiles.go) writes them.
--
-- people is every AniList Staff id the credit tables name: voice actors
-- and production staff alike, as AniList keeps them.
--
-- What a row's three timestamps mean:
--
--   fetched_at    when AniList last returned this id.  Every profile
--                 column is as of then.  NULL: AniList has never returned
--                 it, and the row exists only for the two stamps below --
--                 a reader wants WHERE fetched_at IS NOT NULL.
--   checked_at    when the sweep last asked about this id.  Bookkeeping,
--                 not a fact: a failed ask is stamped back-dated so the id
--                 comes round again in a day rather than in the full
--                 re-check interval.
--   absent_since  when an ask first came back without this id (AniList
--                 deleted it, or merged it into another), NULL again once
--                 one returns it.  A stored profile is kept meanwhile: a
--                 credit that still names the id still needs a name.
--
-- Dates are AniList's FuzzyDate as three columns, because a birthday is
-- most often a month and a day with no year, which no date column holds.
-- The CHECKs on them are the normaliser's own rules (internal/profiles),
-- restated so a value outside them cannot be stored by anything else.
--
-- description is AniList's markdown as it comes, spoiler markers (~!...!~)
-- included: what to show of a spoiler is the reader's decision.
--
-- Locks.  Two new tables and nothing else: no foreign key to anime_cache
-- or the credit tables -- a credit row is written before its profile
-- exists, and a profile outlives the credit that brought it in -- and no
-- index on an existing table, since the sweep looks ids up through the
-- indexes 0037 and 0042 built.  This file takes no lock that any running
-- statement holds or waits for (TestMigration0044_PG applies it while the
-- credit tables are locked).  The tables start empty and the sweep fills
-- them, so there is no backfill to time.

CREATE TABLE people (
    anilist_id          integer PRIMARY KEY,
    name_full           text,
    name_native         text,
    name_alternative    text[] NOT NULL DEFAULT '{}',
    -- AniList's languageV2 label: "Japanese", "Chinese", "Korean", ...
    language            text,
    image_large         text,
    image_medium        text,
    description         text,
    primary_occupations text[] NOT NULL DEFAULT '{}',
    gender              text,
    birth_year          integer,
    birth_month         integer,
    birth_day           integer,
    death_year          integer,
    death_month         integer,
    death_day           integer,
    -- AniList's figure, worked out from the birth date on the day of
    -- fetched_at.
    age                 integer,
    -- Positional, as AniList has it: {first year} while active, {first,
    -- last} once not.
    years_active        integer[] NOT NULL DEFAULT '{}',
    home_town           text,
    blood_type          text,
    favourites          integer,
    site_url            text,
    fetched_at          timestamptz,
    checked_at          timestamptz NOT NULL,
    absent_since        timestamptz,
    CONSTRAINT people_id_positive CHECK (anilist_id > 0),
    CONSTRAINT people_birth_date_parts CHECK (
        (birth_month IS NULL OR birth_month BETWEEN 1 AND 12)
        AND (birth_day IS NULL OR birth_day BETWEEN 1 AND 31)
    ),
    CONSTRAINT people_death_date_parts CHECK (
        (death_month IS NULL OR death_month BETWEEN 1 AND 12)
        AND (death_day IS NULL OR death_day BETWEEN 1 AND 31)
    )
);

-- The sweep's re-check scan: oldest stamp first.
CREATE INDEX people_checked_at_idx ON people (checked_at);

CREATE TABLE characters (
    anilist_id               integer PRIMARY KEY,
    name_full                text,
    name_native              text,
    name_alternative         text[] NOT NULL DEFAULT '{}',
    -- The names AniList hides as spoilers: a true identity, a later form.
    name_alternative_spoiler text[] NOT NULL DEFAULT '{}',
    image_large              text,
    image_medium             text,
    description              text,
    gender                   text,
    birth_year               integer,
    birth_month              integer,
    birth_day                integer,
    -- Free text on AniList: "17", "16-17", "Unknown".
    age                      text,
    blood_type               text,
    favourites               integer,
    site_url                 text,
    fetched_at               timestamptz,
    checked_at               timestamptz NOT NULL,
    absent_since             timestamptz,
    CONSTRAINT characters_id_positive CHECK (anilist_id > 0),
    CONSTRAINT characters_birth_date_parts CHECK (
        (birth_month IS NULL OR birth_month BETWEEN 1 AND 12)
        AND (birth_day IS NULL OR birth_day BETWEEN 1 AND 31)
    )
);

CREATE INDEX characters_checked_at_idx ON characters (checked_at);

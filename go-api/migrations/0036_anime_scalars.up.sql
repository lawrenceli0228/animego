-- The scalars AniList has always offered and the catalogue never asked
-- for.  Each is a field on Media that the four documents now select and
-- the upsert writes; none has a local second source, so each is written
-- plainly (or COALESCEd, where an upstream null means "not stated"
-- rather than "cleared" -- see UpsertAnimeCache).
ALTER TABLE anime_cache
    -- AniList's list-membership count and favourite count: the ranking
    -- signals a browse page sorts on, and the number "how many people
    -- track this" that a detail page can show beside the score.
    ADD COLUMN popularity integer,
    ADD COLUMN favourites integer,
    -- MyAnimeList id.  bgm_id_map carries one for most rows already,
    -- but as a seed-file column keyed off a different join; this is
    -- AniList's own statement, on the row itself, for sameAs links.
    ADD COLUMN mal_id integer,
    -- NOT NULL DEFAULT false: every document selects isAdult, so a row
    -- that has been through any AniList path carries a stated value.
    -- Rows the Express migration seeded and nothing has touched since
    -- read as false, which is why the genre = 'Hentai' exclusions stay
    -- beside the new column rather than being replaced by it.
    ADD COLUMN is_adult boolean NOT NULL DEFAULT false,
    ADD COLUMN country_of_origin text,
    -- The next scheduled episode, as AniList last stated it.  A pair:
    -- an airing time without an episode number, or the reverse, is not
    -- an answer.  Both NULL for a work with nothing scheduled.
    ADD COLUMN next_airing_at timestamptz,
    ADD COLUMN next_airing_episode integer;

ALTER TABLE anime_cache ADD CONSTRAINT anime_next_airing_pair CHECK (
    (next_airing_at IS NULL AND next_airing_episode IS NULL) OR
    (next_airing_at IS NOT NULL AND next_airing_episode IS NOT NULL AND next_airing_episode > 0)
);

ALTER TABLE anime_cache ADD CONSTRAINT anime_counts_nonneg CHECK (
    (popularity IS NULL OR popularity >= 0) AND
    (favourites IS NULL OR favourites >= 0)
);

-- Alternative titles.  A child table like anime_genres rather than an
-- array column, because the reader that wants them is a search that
-- matches one synonym at a time, and the writer replaces the whole set
-- per row (delete + insert), exactly as genres are written.
CREATE TABLE anime_synonyms (
    anime_id integer NOT NULL REFERENCES anime_cache(anilist_id) ON DELETE CASCADE,
    synonym  text    NOT NULL,
    PRIMARY KEY (anime_id, synonym),
    CONSTRAINT anime_synonyms_nonempty CHECK (synonym <> '')
);

-- The facts sweep's stamp answers "has this row been asked the facts
-- question", and the question just got wider: MediaFactsQuery now also
-- selects the block above.  A row stamped under the four-field document
-- has not been asked about popularity or synonyms, so its stamp is void.
-- Clearing them costs one more pass over the catalogue at the sweep's
-- own pace (hourly, 500 rows), which is the price of not carrying two
-- generations of stamp.
UPDATE anime_cache SET facts_checked_at = NULL;

-- Mirror of the up migration, in reverse dependency order: the generated
-- column reads title_hant and title_hant_source, so it has to go first.
--
-- The CHECK constraints are dropped with the columns they constrain -- an
-- explicit DROP CONSTRAINT is not needed and would fail on a partially
-- applied migration, which is the state a down migration is most likely to
-- meet.
--
-- Rolling this back discards every Traditional title and synopsis.  They are
-- all re-derivable: the dataset tiers come from files, the opencc tier from
-- title_chinese.  The one thing that does not come back is a 'manual' row,
-- because nothing else records what the human decided.  Nobody has written
-- one yet; if that changes, export before rolling back.

ALTER TABLE anime_cache
    DROP COLUMN IF EXISTS title_hant_seo;

ALTER TABLE anime_cache
    DROP COLUMN IF EXISTS title_hant,
    DROP COLUMN IF EXISTS title_hant_source,
    DROP COLUMN IF EXISTS title_hant_source_hash,
    DROP COLUMN IF EXISTS description_hant,
    DROP COLUMN IF EXISTS description_hant_source,
    DROP COLUMN IF EXISTS description_hant_source_hash;

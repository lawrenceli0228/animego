-- Reverse of 0014. Dropping the columns discards any harvested Chinese
-- descriptions; they are re-derivable by re-running the backfill against
-- Bangumi, so no data is lost that cannot be refetched.

DROP INDEX IF EXISTS idx_anime_cache_description_cn_missing;

ALTER TABLE anime_cache
    DROP CONSTRAINT IF EXISTS anime_cache_description_cn_source_check;

ALTER TABLE anime_cache
    DROP COLUMN IF EXISTS description_cn_source,
    DROP COLUMN IF EXISTS description_cn;

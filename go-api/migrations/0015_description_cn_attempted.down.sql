-- Reverse of 0015. Restores 0014's index so the schema matches that migration
-- exactly; note the sweep stalls again under it, for the reason 0015 documents.

DROP INDEX IF EXISTS idx_anime_cache_description_cn_pending;

ALTER TABLE anime_cache
    DROP COLUMN IF EXISTS description_cn_attempted_at;

CREATE INDEX IF NOT EXISTS idx_anime_cache_description_cn_missing
    ON anime_cache (anilist_id)
    WHERE description_cn IS NULL AND bgm_id IS NOT NULL;

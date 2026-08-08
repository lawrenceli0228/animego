DROP INDEX IF EXISTS idx_anime_cache_description_cn_llm_pending;

ALTER TABLE anime_cache
    DROP COLUMN IF EXISTS description_cn_llm_attempted_at;

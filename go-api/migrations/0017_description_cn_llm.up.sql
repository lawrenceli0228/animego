-- 0017_description_cn_llm.up.sql — attempt stamp for the LLM translation
-- fallback tier (description_llm_backfill sweep).
--
-- Separate from description_cn_attempted_at on purpose: that column belongs
-- to the Bangumi channel and drives its 30-day re-check cadence.  The two
-- sweeps decide different questions about a row ("does bgm.tv carry usable
-- Chinese prose?" vs "did a translation land?") and sharing one stamp would
-- let either sweep push rows out of the other's queue.
ALTER TABLE anime_cache
    ADD COLUMN IF NOT EXISTS description_cn_llm_attempted_at timestamptz;

-- Partial index shaped exactly like the candidate query's WHERE + ORDER BY:
-- rows with an English source text and no Chinese yet, ordered by attempt
-- stamp so decided rows go to the back of the queue (same finish-guarantee
-- arithmetic as migration 0015 — see description_backfill.go's file header).
CREATE INDEX IF NOT EXISTS idx_anime_cache_description_cn_llm_pending
    ON anime_cache (description_cn_llm_attempted_at NULLS FIRST, anilist_id)
    WHERE description_cn IS NULL AND description IS NOT NULL;

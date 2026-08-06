-- 0014: Chinese description column for anime_cache.
--
-- The site renders AniList's English description to Chinese readers because
-- there has never been a Chinese one to render. Bangumi carries a community
-- written Chinese synopsis (Subject.Summary) which the enrichment workers
-- already receive on every request and currently discard.
--
-- Two columns, not one: `description_cn_source` records where the text came
-- from so a later phase can layer machine translation underneath the human
-- written Bangumi text without losing the ability to tell them apart, and so
-- either origin can be retracted wholesale with a single DELETE-shaped UPDATE.
-- Precedence is manual > bangumi > llm; the writers enforce it, the CHECK only
-- constrains the vocabulary.
--
-- No hash column yet. Machine translation needs one (to know when a source
-- text changed and the translation must be redone) but nothing in this phase
-- writes translations, so it lands with the phase that does.

ALTER TABLE anime_cache
    ADD COLUMN IF NOT EXISTS description_cn text,
    ADD COLUMN IF NOT EXISTS description_cn_source text;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'anime_cache_description_cn_source_check'
    ) THEN
        ALTER TABLE anime_cache
            ADD CONSTRAINT anime_cache_description_cn_source_check
            CHECK (description_cn_source IN ('bangumi', 'llm', 'manual')
                   OR description_cn_source IS NULL);
    END IF;
END $$;

-- Partial index for the backfill sweep and the periodic top-up job, both of
-- which look for "has a Bangumi binding but no Chinese description yet".
-- Partial because the qualifying set shrinks as the backfill progresses,
-- which a full index would not reflect.
CREATE INDEX IF NOT EXISTS idx_anime_cache_description_cn_missing
    ON anime_cache (anilist_id)
    WHERE description_cn IS NULL AND bgm_id IS NOT NULL;

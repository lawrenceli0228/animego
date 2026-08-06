-- 0015: record when a Chinese description was last attempted.
--
-- 0014 let the backfill sweep find work with "description_cn IS NULL", on the
-- assumption that processing a row removes it from the result set. That only
-- holds for rows we can actually fill. Roughly a third of Bangumi summaries are
-- the untranslated Japanese original and get rejected by the language gate, so
-- those rows stay NULL forever — and with ORDER BY anilist_id they hold the
-- same position at the front of every batch.
--
-- The sweep therefore stalls. With batch size B and per-row success rate p,
-- each pass yields B·p^k new rows, so lifetime writes converge to p·B/(1−p):
-- about 450 rows at B=300, p≈0.6, against a backlog of ~9,100. Enlarging the
-- batch does not help — covering N rows would need B ≈ N(1−p)/p ≈ 6,100, i.e.
-- most of the catalogue in a single pass.
--
-- Recording the attempt (not just the success) lets rejected rows fall out of
-- the candidate set on a cooldown, so the sweep advances through the whole
-- backlog. The retry that the cooldown implies is wanted rather than tolerated:
-- Bangumi summaries are written by its community over time, so a subject that
-- is Japanese-only today may well have Chinese prose next quarter, and this is
-- the mechanism that picks it up.

ALTER TABLE anime_cache
    ADD COLUMN IF NOT EXISTS description_cn_attempted_at timestamptz;

-- Replace 0014's index: the sweep now orders by attempt time, so the index has
-- to lead with that column to stay usable for both the filter and the sort.
-- NULLS FIRST matches the query and keeps never-attempted rows at the front.
DROP INDEX IF EXISTS idx_anime_cache_description_cn_missing;

CREATE INDEX IF NOT EXISTS idx_anime_cache_description_cn_pending
    ON anime_cache (description_cn_attempted_at NULLS FIRST, anilist_id)
    WHERE description_cn IS NULL AND bgm_id IS NOT NULL;

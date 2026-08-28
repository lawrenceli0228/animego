-- Drop the index. Nothing else in 0027 to undo -- it adds no column and moves
-- no data, so this returns the schema exactly to its 0026 state.
--
-- Dropping it does not break the search query that reads title_hant: ILIKE
-- still answers correctly without an index, just by sequential scan. On 17k
-- rows that is a slower query, not a failure. So a rollback here degrades
-- search latency rather than search results.
DROP INDEX IF EXISTS anime_cache_title_hant_trgm_idx;

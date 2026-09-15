-- When the facts sweep last asked AniList about this row.
--
-- 0034 made the upsert write start_date, end_date, duration and source,
-- but the upsert only runs for a row somebody fetched: a detail view
-- past its 24h cached_at, a season warm, a search.  Left to that, the
-- back catalogue fills in at the rate people visit it, and the rows
-- nobody visits never fill in at all.  The facts sweep (queue/anime_facts.go)
-- walks the catalogue in id batches instead, and this is its read stamp.
--
-- A separate stamp from anilist_rating_checked_at for the reason 0033
-- gives for keeping the two rating stamps apart: separate sweeps, separate
-- documents, either can be failing while the other is fine, and a shared
-- stamp would let one keep marking rows the other never reached.
--
-- Nullable and unindexed, like the rating stamps.  NULL is "never asked";
-- the candidate query is a seq scan over a few thousand rows once an hour.
ALTER TABLE anime_cache
    ADD COLUMN facts_checked_at timestamptz;

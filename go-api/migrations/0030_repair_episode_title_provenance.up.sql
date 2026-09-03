-- 0030: repair rows whose episode title and its source label disagree.
--
-- 0029 added name_source / name_cn_source and stated the invariant they rest
-- on: a value and its source have to be written by the SAME statement, because
-- a CHECK sees the row after the write and cannot tell a value that was
-- replaced alongside its source from one that was replaced without it.
--
-- For one release that invariant was not held.  The sourced upsert shipped and
-- cmd/bgmbackfill used it, but the two queue writers -- BangumiV2Worker and
-- EpisodesBgmWorker -- were still calling the pre-0029 statement, which set
-- `name` and `name_cn` and never touched the source columns at all.  So when
-- the hourly episodes_bgm sweep passed over a row the dandanplay backfill had
-- just written, the VALUE became Bangumi's (often NULL, because Bangumi had no
-- name for that episode) while the LABEL stayed 'ddp'.
--
-- Measured on production before this migration:
--
--   1,966  name_source = 'ddp'  with BOTH value columns NULL
--      41  name_cn_source set   with name_cn NULL
--       3  name non-NULL        with name_source NULL
--
-- Why it matters beyond tidiness.  The sourced upsert scores precedence
-- against the source column, so a label with no value behind it is not inert:
-- it makes an empty column look CLAIMED at that source's rank, and a later
-- writer of equal or lower rank is then refused.  1,966 episodes would have
-- been permanently unfillable by anything ranked at or below 'ddp' -- which is
-- every automatic writer there is.  A label without a value is worse than no
-- label, because the precedence rule believes it.
--
-- The repair is in two directions and each is decided by the VALUE, which is
-- the only half of the pair that is not in question.  Nothing here reads or
-- writes `name` / `name_cn`: the payload is what it is, this migration only
-- corrects what the row claims about where it came from.

-- A. A source with no value behind it is retracted.
--
-- No attempt is made to work out what the value "should" have been.  The row
-- is simply back to unclaimed, which is what it was before a writer overwrote
-- the value without clearing the label, and which lets the next pass -- from
-- any source -- fill it normally.
UPDATE anime_episode_titles
   SET name_source    = CASE WHEN name    IS NULL THEN NULL ELSE name_source    END,
       name_cn_source = CASE WHEN name_cn IS NULL THEN NULL ELSE name_cn_source END
 WHERE (name    IS NULL AND name_source    IS NOT NULL)
    OR (name_cn IS NULL AND name_cn_source IS NOT NULL);

-- B. A value with no source is labelled 'bangumi'.
--
-- Same proof 0029 used for its own backfill, narrowed to the window that
-- produced these rows: the only writers that can leave a value with no source
-- are the two queue workers on the pre-0029 statement, and both read
-- /subject/{id}/ep.  cmd/bgmbackfill cannot produce this shape -- its statement
-- writes value and source in one CASE pair -- so 'bangumi' is what the data IS
-- rather than the safest guess available.
--
-- Only 3 rows on production, and the count is expected to stay small: this
-- shape needs a row whose value column was NULL before the offending write,
-- which is rarer than overwriting an existing one.
UPDATE anime_episode_titles
   SET name_source    = CASE WHEN name    IS NOT NULL AND name_source    IS NULL
                             THEN 'bangumi' ELSE name_source    END,
       name_cn_source = CASE WHEN name_cn IS NOT NULL AND name_cn_source IS NULL
                             THEN 'bangumi' ELSE name_cn_source END
 WHERE (name    IS NOT NULL AND name_source    IS NULL)
    OR (name_cn IS NOT NULL AND name_cn_source IS NULL);

-- Both statements are re-runnable: their WHERE clauses describe exactly the
-- rows their SET clauses change, so a second application matches nothing.
--
-- Rows left fully empty by step A are NOT deleted.  They are indistinguishable
-- from the ~35k rows that have held two NULLs since before 0029, and those are
-- the only record that an episode number exists at all for entries whose
-- catalogue episode count is unknown -- where the detail grid infers its size
-- from the highest episode number it holds.  Sweeping them here would quietly
-- shorten those grids as a side effect of a provenance repair.
--
-- This migration fixes the damage; it does not stop it recurring.  That is
-- internal/queue/episode_titles_write.go moving both queue writers onto
-- UpsertEpisodeTitleSourced, which ships in the same change.  Applying this
-- file against a server still running the old code would leave the rows to be
-- corrupted again on the next sweep pass.

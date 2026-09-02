-- Mirror of the up migration, in reverse order: section B's index and column
-- first, then section A's provenance columns.
--
-- The CHECK constraints are dropped with the columns they constrain -- an
-- explicit DROP CONSTRAINT is not needed and would fail on a partially
-- applied migration, which is the state a down migration is most likely to
-- meet.  Same reasoning as 0022 and 0023.
--
-- Nothing here touches `name` or `name_cn`.  Rolling back provenance must not
-- roll back the titles themselves: they are the payload, they predate this
-- migration, and a public detail page renders them.
--
-- What rolling back actually discards, and how expensive each loss is:
--
--   name_source / name_cn_source.  The 'bangumi' labels are fully
--   re-derivable -- re-running the up migration reconstructs them from the
--   same proof, because Bangumi is still where every pre-0029 value came
--   from.  A 'ddp' or 'manual' label is NOT: nothing else in the schema
--   records that a dandanplay split or a human decision produced the string
--   sitting in the column.  Re-applying afterwards would relabel those rows
--   'bangumi', which is a wrong claim rather than a missing one, and the
--   precedence rule in the upsert would then let a Bangumi value overwrite
--   the better one.  If any non-'bangumi' source has been written by the time
--   you read this, export the two columns before rolling back.
--
--   episode_titles_at.  The sweep's whole memory.  Losing it puts every
--   RELEASING row back at "never swept", so the next pass re-asks upstream
--   about all of them at once.  That is a spike in upstream requests, not a
--   correctness problem -- the sweep converges again after one cycle.

DROP INDEX IF EXISTS idx_anime_cache_episode_titles_pending;

ALTER TABLE anime_cache
    DROP COLUMN IF EXISTS episode_titles_at;

ALTER TABLE anime_episode_titles
    DROP COLUMN IF EXISTS name_source,
    DROP COLUMN IF EXISTS name_cn_source;

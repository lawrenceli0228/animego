-- Mirror of the up migration.  The index goes first: its predicate reads
-- `episodes`, which survives, but dropping it explicitly keeps the reverse
-- order honest and makes a partially-applied rollback readable.
--
-- The CHECK constraint is dropped with the column it constrains -- an
-- explicit DROP CONSTRAINT is not needed and would fail on a partially
-- applied migration, which is the state a down migration is most likely to
-- meet.  Same reasoning as 0022.
--
-- Rolling this back discards every inferred episode count and the whole
-- attempt ledger.  The counts are re-derivable -- the worker re-reads them
-- from upstream.  The ledger is not: the record of which rows were tried,
-- rejected, or came back empty exists nowhere else, so a re-run after a
-- rollback re-asks upstream for every row including the ones already known
-- to be hopeless.  That is a cost in upstream requests and sweep passes,
-- not a correctness problem.
--
-- Nothing here touches `episodes`.  The authoritative AniList value is not
-- ours to roll back.

DROP INDEX IF EXISTS idx_anime_cache_episodes_bgm_pending;

ALTER TABLE anime_cache
    DROP COLUMN IF EXISTS episodes_bgm,
    DROP COLUMN IF EXISTS episodes_bgm_at,
    DROP COLUMN IF EXISTS episodes_bgm_attempted_at,
    DROP COLUMN IF EXISTS episodes_bgm_outcome,
    DROP COLUMN IF EXISTS episodes_bgm_reason;

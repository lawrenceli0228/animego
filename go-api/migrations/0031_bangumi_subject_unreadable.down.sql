-- Mirror of 0031.  One column, dropped with its comment.
--
-- What rolling this back discards, and what it costs:
--
--   The set of bindings upstream refuses to serve us.  Every one of those
--   rows keeps its bgm_id and keeps bangumi_version = 3, so rolling back does
--   NOT put them back in the pipeline -- they stay terminal, which is
--   correct, because the reason they are terminal has not changed.  What is
--   lost is the ability to name them: after this runs, an unreadable binding
--   is indistinguishable from a readable subject that happens to carry no
--   Rating, and the case for a Bangumi token loses its denominator.
--
--   The loss is recoverable, but only by spending the requests again -- one
--   per candidate row against /v0/subjects.  Nothing else in the schema
--   records the observation, so there is no cheaper reconstruction.
--
-- The worker's write becomes a compile error before it becomes a runtime one:
-- MarkBangumiSubjectUnreadable names this column, so a rollback without the
-- matching code rollback fails at the query, not silently.  That is the
-- intended failure mode -- sqlc validates against this directory, so the
-- mismatch surfaces at generate time for anyone who rolls back and rebuilds.

ALTER TABLE anime_cache
    DROP COLUMN IF EXISTS bangumi_subject_unreadable_at;

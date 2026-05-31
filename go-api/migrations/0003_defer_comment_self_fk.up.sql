-- 0003_defer_comment_self_fk.up.sql
--
-- The episode_comments table has a self-referential FK (parent_id → id)
-- for the reply tree.  Postgres's default constraint timing is IMMEDIATE:
-- the FK is checked per-row at INSERT time.  Our one-shot Mongo→PG
-- migration batches inserts within a single transaction, and a reply
-- comment may be inserted before its parent in that batch, which would
-- raise a violation.
--
-- Switching the constraint to DEFERRABLE INITIALLY DEFERRED moves the
-- check to COMMIT time, by which point every row in the batch is present
-- and the self-FK resolves cleanly.  Steady-state production INSERTs are
-- unaffected because they commit one statement at a time; the constraint
-- still enforces referential integrity at commit boundary.
--
-- Constraint name verified via `\d episode_comments` against the dev
-- Postgres instance: `episode_comments_parent_id_fkey` (PG's default
-- naming `<table>_<column>_fkey`).
ALTER TABLE episode_comments
  ALTER CONSTRAINT episode_comments_parent_id_fkey
  DEFERRABLE INITIALLY DEFERRED;

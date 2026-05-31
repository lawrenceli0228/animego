-- 0003_defer_comment_self_fk.down.sql
--
-- Revert the self-FK on episode_comments.parent_id back to the Postgres
-- default of NOT DEFERRABLE (checked per-row at INSERT time).  Run only
-- if the deferrable behaviour is no longer required and you want to
-- restore the pre-migration constraint shape.
ALTER TABLE episode_comments
  ALTER CONSTRAINT episode_comments_parent_id_fkey
  NOT DEFERRABLE;

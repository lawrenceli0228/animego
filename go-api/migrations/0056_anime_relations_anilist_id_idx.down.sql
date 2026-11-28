-- Drop the index.  Nothing else in 0056 to undo -- it adds no column and
-- moves no data, so this returns the schema exactly to its 0055 state.
--
-- The print-relation lookup still answers correctly without the index,
-- by sequential scan, so rolling this back alone slows that lookup rather
-- than breaking it.
DROP INDEX IF EXISTS anime_relations_anilist_id_idx;

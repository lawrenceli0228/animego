-- Roll the code back to a build that predates 0043 before running this:
-- the credits sweep and the detail refresh both write these columns.
ALTER TABLE anime_cache
    DROP COLUMN IF EXISTS staff_checked_at,
    DROP COLUMN IF EXISTS staff_has_more,
    DROP COLUMN IF EXISTS cast_checked_at,
    DROP COLUMN IF EXISTS cast_has_more;

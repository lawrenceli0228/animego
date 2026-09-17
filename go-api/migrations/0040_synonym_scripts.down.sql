-- The deleted rows cannot be restored from the database; the next detail
-- read or facts sweep re-reads the title's synonyms from AniList (through
-- the same filter, so they stay out until it changes).  Nothing to undo.
SELECT 1;

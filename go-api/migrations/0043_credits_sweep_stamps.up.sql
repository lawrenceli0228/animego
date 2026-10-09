-- 0043: what the credits sweep runs on.
--
-- Four anime_cache columns for queue/anime_credits.go, the sweep that
-- fetches a title's characters and staff beyond AniList's first page (see
-- 0042 for the tables it writes).
--
-- *_has_more: whether AniList had a second page the last time page 1 was
-- read (pageInfo.hasNextPage), written by the detail refresh and by the
-- sweep.  NULL is "not read since this column existed"; the sweep treats
-- a NULL with a full page of rows as worth one look.
--
-- *_checked_at: when the sweep last fetched the whole list.  NULL is
-- never.  A failed fetch is stamped back-dated so the title comes round
-- again after a day rather than heading every pass, and a flag turning
-- true clears the stamp (see queue/anime_credits.go and
-- SetAnimeCreditsHasMore).
--
-- Nullable, no default, unindexed: adding them is a catalogue change with
-- no table rewrite, and the candidate scan is a few thousand rows every
-- few minutes, like the facts and ratings stamps.
--
-- A file of its own, apart from 0042, so the ACCESS EXCLUSIVE lock this
-- ALTER needs is the only lock its transaction ever waits for: queued
-- behind a long anime_cache read, it holds nothing else meanwhile.
ALTER TABLE anime_cache
    ADD COLUMN cast_has_more    boolean,
    ADD COLUMN cast_checked_at  timestamptz,
    ADD COLUMN staff_has_more   boolean,
    ADD COLUMN staff_checked_at timestamptz;

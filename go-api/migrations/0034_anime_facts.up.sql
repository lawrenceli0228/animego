-- Two columns for two different gaps on the same row.
--
-- end_date: AnimeDetailQuery has selected startDate, endDate, duration and
-- source since the port, and anime_cache has carried start_date, duration
-- and source since 0001 -- but UpsertAnimeCache never listed them, so the
-- three columns were only ever populated by the one-off Express migration
-- and every AniList fetch since has thrown the values away.  end_date is
-- the fourth of that set and never had a column at all.  The upsert now
-- writes all four (see UpsertAnimeCache); this migration only adds the
-- one that was missing.
ALTER TABLE anime_cache
    ADD COLUMN end_date date;

-- detail_fetched_at: when AnimeDetailQuery last produced this row.
--
-- The detail read decides whether a cached row is worth serving or must be
-- re-fetched, and until now it inferred "never been through the detail
-- query" from "has no studios" or "has no characters".  That inference is
-- wrong for exactly the rows AniList has no main studio or no character
-- for: the detail fetch writes an empty set, the next read sees the empty
-- set, infers the fetch never happened, and fetches again -- once per
-- in-process cache expiry, forever.
--
-- A timestamp rather than a boolean for the same reason as
-- trailer_checked_at: NULL is "never asked", a value is "asked, and what is
-- stored is the answer", and a cutoff on the value is how a re-sweep is
-- expressed later.  Only the two callers that run AnimeDetailQuery write
-- it; a listing upsert leaves it alone (CASE in UpsertAnimeCache).
ALTER TABLE anime_cache
    ADD COLUMN detail_fetched_at timestamptz;

-- Stamp the rows the old inference would have called fetched, so the
-- switch from inference to stamp does not turn the whole catalogue into
-- "never asked" on deploy.  This is the old heuristic applied one last
-- time: any row with child rows in a table only the detail path writes has
-- been through that path.  Rows the detail path visited and found nothing
-- for stay NULL and pay one more fetch, after which the upsert stamps
-- them -- which is the terminating behaviour the column exists to provide.
--
-- anime_genres is deliberately not in the list: the seasonal listing
-- writes it too, so it says nothing about the detail path.
UPDATE anime_cache a
SET detail_fetched_at = a.cached_at
WHERE a.detail_fetched_at IS NULL
  AND (
       EXISTS (SELECT 1 FROM anime_studios         s WHERE s.anime_id = a.anilist_id)
    OR EXISTS (SELECT 1 FROM anime_characters      c WHERE c.anime_id = a.anilist_id)
    OR EXISTS (SELECT 1 FROM anime_staff           t WHERE t.anime_id = a.anilist_id)
    OR EXISTS (SELECT 1 FROM anime_relations       r WHERE r.anime_id = a.anilist_id)
    OR EXISTS (SELECT 1 FROM anime_recommendations m WHERE m.anime_id = a.anilist_id)
  );

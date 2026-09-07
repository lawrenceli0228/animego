-- Rating counts, and the stamps that decide when to ask again.
--
-- anime_cache already stores two scores and one count: average_score
-- (AniList, 0-100) and bangumi_score / bangumi_votes (Bangumi, 0-10 plus
-- the "N 人评分" figure the subject page prints).  The AniList half has
-- no count, so the two sources are not comparable -- an 84 backed by
-- forty raters and an 84 backed by forty thousand read identically, and
-- nothing downstream can tell them apart or weigh them against Bangumi's
-- 18,023.
--
-- AniList's GraphQL schema has no scalar for this.  What it has is
-- stats.scoreDistribution, a bucket-per-decile histogram whose amounts
-- sum to the number of users who scored the work; that sum is the
-- analogue of Bangumi's rating.total and is what this column holds.
-- popularity is NOT that number -- it counts list entries, most of which
-- carry no score -- and storing it here would answer a different
-- question in the same column.
ALTER TABLE anime_cache
    ADD COLUMN anilist_score_votes integer;

-- Two stamps, not one, and timestamps rather than flags.
--
-- The timestamp is the same argument migration 0032 makes for
-- trailer_checked_at: the column has to answer three questions and a
-- boolean answers only the first.
--
--   NULL              nobody has asked this source about this row yet
--   <when we asked>   a zero count here is an answer, not a gap
--   < some cutoff     due to be asked again
--
-- The third is what the refresh cadence is built on.  A rating is not a
-- fact that settles: SUMMER 2026 -- airing as this migration is written
-- -- averages 8 Bangumi votes across 102 rows because every one of them
-- was read once, at announcement, and never again; WINTER 2026 averages
-- 1,270 for no reason other than having been read later in its life.
-- Both numbers are stale in the same way and neither row can say so.
-- With a stamp, "which rows are due" is a WHERE clause, and "we asked
-- and the answer really was zero" stops looking like "we never asked".
--
-- They are separate columns because the two sweeps are separate: one
-- batches 50 ids into a single AniList document, the other spends one
-- Bangumi request per row through a bucket the request path shares.
-- They run at different rates, and either can be failing while the other
-- is fine.  A single stamp would let the cheap sweep keep marking rows
-- the expensive one never reached.
ALTER TABLE anime_cache
    ADD COLUMN anilist_rating_checked_at timestamptz,
    ADD COLUMN bangumi_rating_checked_at timestamptz;

-- A count is meaningless without the observation that produced it: it is
-- a number of people, so it is never negative, and it can only exist on
-- a row we actually asked about.  Both halves are refused at the column
-- because the writer swallows a per-row update failure -- a value that
-- got past the caller and was refused here would show up as a row that
-- quietly stops refreshing, not as an error anyone sees.
--
-- Note this constrains only the AniList side.  bangumi_votes predates
-- this migration by 32 of them and is already populated on 12,390 rows;
-- adding a NOT VALID check for it belongs to whoever is willing to
-- validate those rows, not to this one.
ALTER TABLE anime_cache ADD CONSTRAINT anime_anilist_rating_pair CHECK (
    anilist_score_votes IS NULL OR
    (anilist_score_votes >= 0 AND anilist_rating_checked_at IS NOT NULL)
);

-- No index on either stamp.  The candidate queries scan the whole table
-- once per sweep and 18,458 rows is a few milliseconds of seq scan; an
-- index would be read by nothing else and would have to be maintained by
-- every one of the five paths that write this table.  Same reasoning as
-- migration 0031's note on bangumi_subject_unreadable_at.  Revisit if
-- anime_cache grows an order of magnitude.

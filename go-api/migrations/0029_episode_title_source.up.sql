-- 0029: per-field provenance for episode titles, plus the one stamp the
-- RELEASING re-sweep needs to find work.
--
-- anime_episode_titles (0001:136) has carried the same four columns since the
-- schema was created: (anime_id, episode) as the key, `name` and `name_cn` as
-- the payload.  A row says what an episode is called and is silent about who
-- decided that.  That was survivable while everything writing the table read
-- from one upstream.  It stops being survivable the moment a second upstream
-- arrives, because the upsert then has to answer a question the row does not
-- contain: may the value already sitting here be replaced by the one I am
-- holding?  Precedence needs a source to compare, and there is nowhere to
-- record one.
--
-- This migration adds that somewhere, and the timestamp a periodic top-up
-- needs so it can ask again about shows that are still airing.
--
--
-- ============================================================
-- A.  Provenance, per FIELD rather than per ROW
-- ============================================================
--
-- Two columns rather than one, and the reason is not symmetry.  The two
-- payload columns are fed by upstreams with different coverage:
--
--   Bangumi's /subject/{id}/ep returns `name` and `name_cn` as separate
--   fields, so a Bangumi write can fill either, both, or neither.
--
--   dandanplay's episode feed returns ONE string per episode.  Its body is
--   Chinese on some rows and Japanese on others, so a single dandanplay
--   value lands in name_cn on one episode and in name on the next.
--
-- So a single row-level `source` column is not merely coarse, it is unable to
-- describe states this table will actually hold: name from Bangumi beside a
-- name_cn from dandanplay, in one row, is the ordinary case rather than the
-- corner one.  Labelling that row 'bangumi' or 'ddp' would be a false claim
-- either way, and precedence computed from a false claim overwrites the
-- better value with the worse one.  Per-field is the smallest granularity
-- that is not a lie.
--
-- Vocabulary, in precedence order:
--
--   manual    a human decided.  No path writes this today -- the admin
--             surface can only DELETE episode titles, never edit them
--             (admin.sql DeleteAnimeEpisodeTitlesForReset on a full reset,
--             and the cleared_titles CTE inside UpdateAnimeEnrichmentSelective
--             on a re-binding) -- and the value is admitted now so that
--             adding the editor later is a code change, not a migration.
--   ddp       dandanplay, split out of its single episodeTitle field.
--   bangumi   bgm.tv, via /subject/{id}/ep.
--
-- The CHECK constrains the VOCABULARY only; it says nothing about which
-- source may overwrite which.  That is the same division of labour 0014 and
-- 0022 drew, with one difference worth naming: there, precedence was left to
-- "the writers", spread across whichever jobs happened to write the column.
-- Here it belongs in the SQL of the upsert itself, so that a new writer
-- inherits the rule by using the query rather than by remembering it.  A
-- constraint cannot express precedence anyway -- it sees one row at a time
-- and precedence is a statement about the transition into that row.
--
-- The CHECK is inline rather than in a DO/pg_constraint block as 0014 and
-- 0022 use.  Those two attached constraints to columns that could already
-- exist from an earlier partial run, so the constraint had to be added
-- separately and guarded.  Both columns here are new in this migration: the
-- column and its CHECK always land together, and ADD COLUMN IF NOT EXISTS
-- skips both as a unit on a re-run.  Same reasoning as 0023, same shape.

ALTER TABLE anime_episode_titles
    ADD COLUMN IF NOT EXISTS name_source text
        CHECK (name_source IS NULL
               OR name_source IN ('manual', 'ddp', 'bangumi')),
    ADD COLUMN IF NOT EXISTS name_cn_source text
        CHECK (name_cn_source IS NULL
               OR name_cn_source IN ('manual', 'ddp', 'bangumi'));

-- Backfill: every existing value is 'bangumi', and that is provable rather
-- than assumed.
--
-- The table has exactly one INSERT path -- UpsertEpisodeTitle
-- (db/queries/anime_cache.sql) -- plus the one-time load that created the
-- rows in the first place.  Enumerated, that is three writers and no fourth:
--
--   internal/queue/bangumi_v2.go        BangumiV2Worker, last step of a full
--                                       enrichment run, from /subject/{id}/ep
--   internal/queue/bangumi_episodes.go  EpisodesBgmWorker (migration 0023),
--                                       from the same endpoint, after its
--                                       identity gate accepts the binding
--   internal/migrate/transforms/anime_cache.go:428
--                                       the Mongo -> Postgres transform,
--                                       reading the `episodeTitles` array the
--                                       Express Bangumi pipeline had written
--
-- All three derive from Bangumi, and the field names survive the whole way
-- down: Bangumi's name/name_cn are Mongo's name/nameCn are this table's
-- name/name_cn.  So 'bangumi' is what the data IS, not the safest guess
-- available.  (Both queue workers now share one write loop in
-- internal/queue/episode_titles_write.go; that consolidation does not change
-- the provenance, only how many copies of the loop there are.)
--
-- A source is set only where the value it describes is non-NULL.  A NULL
-- value has no provenance -- nobody decided it, it is the absence of a
-- decision -- and stamping one would manufacture a claim that a later
-- precedence check would then honour, blocking the first real value from
-- being written.
--
-- The IS NULL guards on the source columns make the statement re-runnable
-- rather than merely idempotent-looking.  ADD COLUMN IF NOT EXISTS above
-- means this file can legitimately be applied twice; without the guard, a
-- second run would relabel as 'bangumi' every row a writer had since marked
-- 'ddp' or 'manual' -- silently, and in the direction that loses the better
-- value.  The same predicates in the WHERE keep the second run from
-- rewriting any row at all, so it costs nothing and produces no dead tuples.
UPDATE anime_episode_titles
   SET name_source    = CASE WHEN name IS NOT NULL AND name_source IS NULL
                             THEN 'bangumi' ELSE name_source END,
       name_cn_source = CASE WHEN name_cn IS NOT NULL AND name_cn_source IS NULL
                             THEN 'bangumi' ELSE name_cn_source END
 WHERE (name    IS NOT NULL AND name_source    IS NULL)
    OR (name_cn IS NOT NULL AND name_cn_source IS NULL);

-- No *_source_hash column, and that is a decision rather than a copy of 0022
-- that got shortened.
--
-- 0022 needed a digest because title_hant was DERIVED from another column in
-- the same row: title_chinese could be rewritten underneath a conversion and
-- nothing in the schema would notice the conversion had gone stale.  Nothing
-- here is derived from anything in this database.  name and name_cn are
-- copied out of an upstream response, and the source label describes which
-- upstream that was.  There is no input string to digest, so a hash column
-- would have nothing to put in it.
--
-- What the schema still cannot enforce, recorded so it is not rediscovered as
-- a bug: a value and its source have to be written by the SAME statement.  A
-- CHECK sees the row after the write and cannot tell whether name_cn was
-- replaced while name_cn_source was left behind, which would leave a
-- dandanplay string wearing a 'bangumi' label.  The upsert is where that
-- pairing has to hold, and it holds by construction only as long as every
-- writer goes through it.


-- ============================================================
-- B.  The sweep stamp
-- ============================================================
--
-- Episode titles for a show that is still airing are incomplete by
-- construction: the upstream learns episode 9's name in the week episode 9
-- airs.  A one-shot enrichment pass therefore cannot finish the job for
-- anything currently broadcasting, and a periodic re-ask is not an
-- optimisation but the only way those rows ever fill in.
--
-- One column records when a row was last swept.  It is an ATTEMPT stamp, not
-- a success stamp -- the sweep writes it whether or not the pass produced a
-- title -- and section C below is about why one clock is enough here when
-- 0023 needed two.
ALTER TABLE anime_cache
    ADD COLUMN IF NOT EXISTS episode_titles_at timestamptz;

-- Partial index for the sweep's candidate query.  The predicate the sweep is
-- specified to run is:
--
--   status = 'RELEASING'
--   AND bgm_id IS NOT NULL
--   AND (episode_titles_at IS NULL
--        OR episode_titles_at < now() - interval '26 hours')
--
-- ordered by episode_titles_at NULLS FIRST, anilist_id.
--
-- Only the first two conjuncts can go in the index predicate, and that is a
-- hard limit rather than a preference: an index predicate admits only
-- IMMUTABLE expressions and now() is STABLE, so the freshness arm cannot
-- appear in one at all.  0023 hit the same wall for the same reason.
--
-- Unlike 0023, though, the excluded arm costs almost nothing here, because it
-- is on the LEADING KEY COLUMN.  The rows it rejects are exactly the ones the
-- ordering puts at the BACK: never-swept rows sort first, then oldest-swept,
-- and the recently-swept rows that fail the freshness test are last.  So an
-- ordered scan of this index reads its qualifying prefix and stops; it never
-- walks past the rows the predicate could not describe.  That is the whole
-- reason to lead on the timestamp instead of merely storing it.
--
-- The predicate columns are the two that do not move as the sweep works.  The
-- sweep writes episode_titles_at and anime_episode_titles rows; it never
-- writes status or bgm_id, so no row can leave or enter this index because of
-- its own processing.  status = 'RELEASING' also makes the index small -- the
-- airing slice of the catalogue, not the catalogue -- and bgm_id IS NOT NULL
-- narrows it again to rows that have an upstream to ask.  Maintenance cost is
-- bounded by how often AniList sync rewrites status, which is a handful of
-- transitions per title per lifetime.
--
-- 26 hours rather than 24 is the sweep's constant, not the schema's, but it
-- is worth recording why the index does not care: any interval longer than
-- the sweep's own period leaves the qualifying set a prefix of this ordering,
-- and the exact number only decides how long that prefix is.
CREATE INDEX IF NOT EXISTS idx_anime_cache_episode_titles_pending
    ON anime_cache (episode_titles_at NULLS FIRST, anilist_id)
    WHERE status = 'RELEASING' AND bgm_id IS NOT NULL;


-- ============================================================
-- C.  Why ONE state column here and five in 0023
-- ============================================================
--
-- Stated explicitly, because the two migrations immediately upstream of this
-- one both concluded the opposite and a reader who knows them will assume the
-- pattern was forgotten rather than declined.
--
-- 0015 and 0023 added attempt/outcome columns to anime_cache to stop a sweep
-- from stalling.  Both of those sweeps scan the WHOLE CATALOGUE, and both
-- decided candidacy on "the value is still missing".  A row that can never
-- produce a value -- a Japanese-only summary in 0015, a binding the identity
-- gate refuses in 0023 -- therefore stayed true forever, held the front of
-- every batch under ORDER BY anilist_id, and starved every row behind it.
-- 0015 works out the arithmetic: lifetime writes converge to p*B/(1-p), a
-- fraction of the backlog that no batch size can fix.  The extra columns
-- exist so a decided row can be moved out of the way.
--
-- That failure needs two ingredients, and this sweep has neither.
--
-- First, candidacy here is not "the value is missing".  It is the attempt
-- stamp, which the sweep writes on every pass regardless of outcome, so a row
-- that yields nothing still goes to the back of the queue and every other
-- candidate gets its turn within one cycle.  A hopeless row costs one request
-- a day; it does not cost another row its slot.  That is the distinction --
-- not whether effort is wasted, but whether a row can OCCUPY A SLOT that
-- another row needs.
--
-- Second, the candidate set is anchored on status = 'RELEASING', which
-- shrinks on its own.  AniList sync flips a show to FINISHED when it ends and
-- the row leaves the set for good, without this sweep doing anything.  The
-- set is bounded by how much is airing at once rather than by how large the
-- catalogue has grown, so there is no backlog to drain and nothing to
-- accumulate.  0015's and 0023's candidate sets grow monotonically with the
-- catalogue; this one does not.
--
-- Given that, an outcome vocabulary would record a per-row history nobody
-- queries: there is no cooldown to differentiate, because every candidate
-- gets the same 26 hours, and there is no "do not retry soon" state to
-- express, because for an airing show retrying soon is the entire point.
--
-- THE GUARD ON THAT ARGUMENT: it holds only while the candidate set stays
-- anchored on status = 'RELEASING'.  Widening the sweep to backfill finished
-- shows -- a one-time pass over the catalogue's tail, say -- restores both
-- ingredients at once, and 0015's arithmetic comes back with them.  Such a
-- pass needs 0023's attempt/outcome columns, and they must land in the
-- migration that widens the predicate, not afterwards.

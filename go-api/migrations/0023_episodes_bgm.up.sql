-- 0023: inferred episode count from the external episode source, plus the
-- accounting a sweep needs to stop asking.
--
-- AniList leaves `episodes` NULL for a large slice of the catalogue -- most
-- of what is currently airing, plus assorted ONAs and shorts.  A later
-- worker fills that gap from an external episode source, which knows a
-- total for many of those titles.  The value it derives is stored
-- separately, in `episodes_bgm`, and never merged into `episodes`: see the
-- authority note at the bottom.
--
-- Five columns, and the three that are easy to skip are the ones that make
-- the sweep terminate:
--
--   episodes_bgm               the inferred count
--   episodes_bgm_at            when a count was last WRITTEN
--   episodes_bgm_attempted_at  when the row was last TRIED
--   episodes_bgm_outcome       what happened on that try
--   episodes_bgm_reason        free text detail for the non-'ok' outcomes
--
-- `at` and `attempted_at` are not the same clock and collapsing them loses
-- the distinction the sweep runs on.  A row rejected by the identity gate,
-- or one whose upstream returned an empty episode list, produces no value
-- to stamp `episodes_bgm_at` with -- so with only `episodes_bgm IS NULL` as
-- the candidate test it stays at the front of every batch, forever.  That
-- is not hypothetical: 0015_description_cn_attempted.up.sql is the same
-- stall, already observed once on this table, and it works out there that
-- lifetime writes converge to a fraction of the backlog no batch size can
-- fix.  Recording the attempt is what moves a decided row out of the way.
--
-- The outcome vocabulary is three-state accounting, not a success flag:
--
--   ok          a count was derived and written
--   rejected    the identity gate refused the binding; do not retry soon
--   undecided   the gate could not tell; a later run with better data may
--   empty       upstream answered, with no episodes
--   error       upstream failed to answer; the retry is river's problem,
--               not the sweep's
--
-- `rejected` and `undecided` have to be distinguishable because they earn
-- different cooldowns, and `empty` has to be distinguishable from both
-- because it is a *correct* answer that happens to yield nothing.
--
-- The existing `admin_flag` column cannot carry this.  Its CHECK
-- (0001_init.up.sql:68) admits exactly 'needs-review' and
-- 'manually-corrected' -- a two-value human-workflow flag, already read by
-- the admin surface, with no room for a machine outcome.  Widening it would
-- overload one column with two unrelated state machines and break every
-- existing reader's exhaustiveness assumption.
--
-- The CHECK is inline rather than in a DO/pg_constraint block as 0014 and
-- 0022 do.  Those two added constraints to columns that could already exist
-- from an earlier partial run; all five columns here are new in this
-- migration, so the column and its constraint always land together, and
-- ADD COLUMN IF NOT EXISTS skips both as a unit on a re-run.

ALTER TABLE anime_cache
    ADD COLUMN IF NOT EXISTS episodes_bgm              integer,
    ADD COLUMN IF NOT EXISTS episodes_bgm_at           timestamptz,
    ADD COLUMN IF NOT EXISTS episodes_bgm_attempted_at timestamptz,
    ADD COLUMN IF NOT EXISTS episodes_bgm_outcome      text
        CHECK (episodes_bgm_outcome IS NULL
               OR episodes_bgm_outcome IN ('ok','rejected','undecided','empty','error')),
    ADD COLUMN IF NOT EXISTS episodes_bgm_reason       text;

-- Partial index for the sweep's candidate query.  The predicate the worker
-- is specified to use is:
--
--   episodes IS NULL
--   AND (episodes_bgm IS NULL
--        OR (status = 'RELEASING' AND episodes_bgm_at < now() - interval '20 hours'))
--
-- Only the first conjunct can go in an index predicate, and that is a hard
-- limit rather than a preference: an index predicate may contain only
-- IMMUTABLE functions and now() is STABLE, so the freshness arm cannot
-- appear in one at all.  The OR is a heap filter whatever we do here.
--
-- `episodes IS NULL` is the right anchor anyway.  It is the one conjunct
-- that does not move as the worker makes progress -- writing episodes_bgm
-- does not remove a row from it; only an AniList sync that finally learns a
-- real total does.  It is also the selective one: the qualifying set is the
-- airing-and-unknown-length tail of the catalogue, not the catalogue.  That
-- keeps the index small, and its maintenance cost is bounded by how often
-- AniList sync rewrites `episodes`, which is rarely per row.
--
-- The key columns are chosen for the query the sweep will end up running,
-- not the one written above, and the difference is deliberate.  As
-- specified, the predicate re-selects every row it rejected: a row the
-- identity gate refused, or one that came back empty, never gets an
-- episodes_bgm, so `episodes_bgm IS NULL` stays true and it sits at the
-- front of the next batch and the one after.  That is the 0015 stall
-- exactly, on the same table, and the columns immediately above this
-- comment exist to prevent it -- so the predicate has to grow an
-- episodes_bgm_attempted_at cooldown term before the sweep can drain, and
-- it will then want 0015's ORDER BY episodes_bgm_attempted_at NULLS FIRST.
--
-- Leading on episodes_bgm_attempted_at costs the specified predicate
-- nothing (neither key column narrows that filter -- the partial WHERE is
-- what does the work, and the leading column only decides output order) and
-- saves the corrected one an index rebuild.  0014 shipped the ordering the
-- sweep turned out not to want and 0015 dropped it eight lines into its own
-- migration; this repo has already paid for that lesson once.
--
-- Stated plainly rather than discovered later: at the current table size a
-- sequential scan is also perfectly adequate for an hourly job and the
-- planner may well choose one.  This index is cheap insurance against the
-- catalogue growing, not a measured win today.
CREATE INDEX IF NOT EXISTS idx_anime_cache_episodes_bgm_pending
    ON anime_cache (episodes_bgm_attempted_at NULLS FIRST, anilist_id)
    WHERE episodes IS NULL;

-- Authority note, recorded here because the schema is the only place both
-- columns are visible side by side.
--
-- `episodes` stays the authoritative value and `episodes_bgm` stays the
-- inferred one, and nothing may coalesce them on the way out of the
-- database.  The reason is not tidiness: a downstream consumer emits
-- numberOfEpisodes into schema.org JSON-LD, and only the authoritative
-- value is allowed to appear there.  A COALESCE in a query, a view, or a
-- DTO would launder an inferred count into structured data that search
-- engines treat as a factual claim about the work.
--
-- This is the same boundary 0022 drew for title_hant_seo, and it is drawn
-- differently on purpose.  There the safe projection got its own generated
-- column because forty-odd render sites could reach the unsafe one and a
-- reviewer could not tell from a call site which was which.  Here the two
-- values are already two columns with two names, and the risk is the
-- opposite direction -- someone merging them for convenience.  A generated
-- column would not prevent that, so the rule lives in the API contract: the
-- read endpoint returns both fields, separately, and adds no third
-- coalescing field.

-- 0024: the set of episodes a user has actually marked watched, promoted
-- from an inference to a record.
--
-- Until now the per-episode checkmarks on the detail page were derived
-- from a single integer, `subscriptions.current_episode`, with the rule
-- `watched = episode < current_episode`.  That integer is a position, and
-- the grid rendered it as a set: a reader who watched only episode 5 saw
-- episodes 1-4 drawn as watched.  An aggregate progress bar is allowed to
-- approximate; a mark against a specific episode is a specific claim about
-- that episode and may not be wrong.
--
-- So the set becomes the stored thing and the integer becomes derived from
-- it.  `subscriptions.current_episode` keeps its column, its type and its
-- meaning (COALESCE(MAX(episode), 0) over this table), so every existing
-- consumer -- the continue-watching card, the activity feed, the list
-- endpoint -- keeps working untouched.
--
-- One row per (user, anime, episode).  No surrogate key: the natural key
-- IS the fact being recorded, and a serial id would only create a second
-- way to say the same thing.
--
-- `watched_at` is the time the mark was made, not the time the episode was
-- watched -- we do not know the latter and must not pretend to.  Nothing
-- reads it yet; it exists because a set with no timestamps cannot answer
-- "when did this user's marks arrive", which is the first question any
-- later investigation of this table will ask.
--
-- Three foreign keys, and the composite one is the load-bearing one.
--
-- The marks belong to the SUBSCRIPTION, not merely to the user and the
-- title independently.  With only the two column-level FKs, DELETE
-- /api/subscriptions/:anilistId would remove the subscription row and
-- leave this table untouched, so an unsubscribe-then-resubscribe cycle
-- would find the old marks still here -- and the first later mark would
-- recompute current_episode from a set the user believed they had thrown
-- away.  That is silent resurrection of deleted data, so the composite FK
-- on (user_id, anilist_id) closes it: subscriptions' primary key is
-- exactly that pair, so the reference is available and the cascade is
-- exact.
--
-- The two column-level FKs are, strictly, now redundant for cascade
-- purposes -- deleting a user or a cached title cascades to
-- `subscriptions` (both of ITS foreign keys are ON DELETE CASCADE,
-- 0001_init.up.sql), which cascades here.  They are kept anyway, as
-- independent guarantees that do not depend on another table's constraint
-- staying the way it is today.  Three row triggers per insert on a table
-- written by a checkbox click is not a cost worth optimising.
--
-- Consequence worth naming: the composite FK also makes "no subscription,
-- no marks" a database rule and not just a handler rule.  The API answers
-- 404 before it gets here, but a writer that skipped the handler cannot
-- create an orphan even by accident.

CREATE TABLE IF NOT EXISTS episode_watches (
    user_id    uuid        NOT NULL REFERENCES users(id)               ON DELETE CASCADE,
    anilist_id integer     NOT NULL REFERENCES anime_cache(anilist_id) ON DELETE CASCADE,
    -- The upper bound is not decoration and it is not arbitrary.
    --
    -- Without a bound, `episode` is a signed 32-bit integer and one request
    -- naming a large value is enough to make the backfill below -- or any
    -- future range write -- attempt an arbitrary number of rows.  With a
    -- tight bound (say 200, "nobody watches more than that") the constraint
    -- would reject real data: several catalogued series run past a thousand
    -- episodes and a few past two thousand, and a long-runner is exactly the
    -- title whose per-episode grid is most worth getting right.
    --
    -- 5000 sits above every run length in the catalogue with room to spare
    -- and still caps the blast radius of a single statement at five thousand
    -- rows.  It is a safety ceiling, not a product limit; if a real title
    -- ever approaches it, raise it here rather than working around it.
    --
    -- The API layer rejects out-of-range episodes with a 400 before they
    -- reach this constraint, so a client sees a clear error rather than a
    -- constraint violation surfacing as a 500.  This CHECK is the backstop
    -- for every writer that is not that handler.
    episode    integer     NOT NULL CHECK (episode > 0 AND episode <= 5000),
    watched_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, anilist_id, episode),
    FOREIGN KEY (user_id, anilist_id)
        REFERENCES subscriptions (user_id, anilist_id) ON DELETE CASCADE
);

-- No secondary index, deliberately.
--
-- Every read this table has is "the watched set for one user and one
-- anime": WHERE user_id = $1 AND anilist_id = $2, optionally ORDER BY
-- episode.  That is the primary key's leading columns in the primary key's
-- order, so the PK index already serves it as a range scan and returns it
-- pre-sorted.  A separate index on (user_id, anilist_id) would be a strict
-- prefix of the PK -- redundant storage and an extra write on every mark,
-- for no plan the planner could not already reach.
--
-- Stated here so the next person reading this file does not add one and
-- assume it was an oversight.

-- One-time promotion of an inference to a record.
--
-- For every subscription already carrying progress, write episodes
-- 1 .. current_episode into the set.  This is deliberately lossy, and
-- lossy in the honest direction: it asserts what the row has been claiming
-- all along.  A subscription sitting at 7 has been saying "seven episodes
-- watched" on every page view, so recording seven marks changes nothing
-- the user was ever told -- it only makes the claim inspectable and, from
-- now on, correctable.  The alternative (start everyone from an empty set)
-- would silently un-watch every existing reader's whole history to buy a
-- purity nobody asked for.
--
-- The range is inclusive of current_episode, and that is the load-bearing
-- choice.  The old grid drew `episode < current_episode`, so it rendered
-- 1-6 for a row sitting at 7 and left 7 itself blank -- an off-by-one the
-- rest of the system never shared (the PATCH bound accepts
-- current_episode == total, i.e. "finished", and the card reads it as a
-- count).  Promoting 1-6 would make MAX(episode) six against a stored
-- seven, so the derived value would contradict its own source before a
-- single user had touched anything.  1 .. N is what makes
-- current_episode = COALESCE(MAX(episode), 0) true from the first moment,
-- which is the invariant everything downstream now rests on.
--
-- ⚠️ VISIBLE CONSEQUENCE, SO NOBODY GOES HUNTING FOR A REGRESSION.  The
-- first render after this migration shows exactly ONE MORE CHECKMARK than
-- the last render before it, on episode N itself.  This is not a bug and
-- nothing regressed: it is the old grid's off-by-one being corrected.  The
-- row said "at episode 7" and the grid drew six checkmarks; it now draws
-- seven, which is what the row was saying all along.
--
-- What is genuinely lost is which of those episodes were actually watched,
-- and when.  That was never recorded, so it is not being discarded here --
-- it never existed.  `watched_at` therefore stamps the migration time for
-- every backfilled row, and that is why the column documents itself as
-- "when the mark was made".
--
-- LEAST(..., 5000) guards the CHECK above.  `current_episode` has no
-- upper-bound constraint of its own, and the API only bounds it when
-- anime_cache.episodes is known -- a still-airing title has no known
-- total, so nothing today stops a wild value from reaching the column.
-- Without the guard one such row would abort the whole migration, or,
-- worse, expand into a generate_series of that length.
--
-- ON CONFLICT DO NOTHING keeps the statement idempotent, so a re-run
-- after a partially-applied migration converges instead of failing.
INSERT INTO episode_watches (user_id, anilist_id, episode)
SELECT s.user_id, s.anilist_id, g.episode
FROM subscriptions s
CROSS JOIN LATERAL generate_series(1, LEAST(s.current_episode, 5000)) AS g(episode)
WHERE s.current_episode > 0
ON CONFLICT (user_id, anilist_id, episode) DO NOTHING;

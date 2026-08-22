-- Queries against the subscriptions table (P2.4).
--
-- The subscriptions table has a (user_id, anilist_id) composite PK + FKs
-- to users(id) ON DELETE CASCADE and anime_cache(anilist_id) ON DELETE
-- CASCADE.  Five endpoints back this surface:
--
--   GET    /api/subscriptions               → ListUserSubscriptions
--   GET    /api/subscriptions/:anilistId    → GetSubscription
--   POST   /api/subscriptions               → UpsertSubscription
--                                             InsertSubscriptionIfAbsent
--                                             (when the body sets ifAbsent)
--   PATCH  /api/subscriptions/:anilistId    → UpdateSubscriptionWithActivity
--   DELETE /api/subscriptions/:anilistId    → DeleteSubscription
--
-- Express joined Subscription + AnimeCache in application code; here we
-- do the join in SQL so the network round-trip is one query for the
-- list endpoint.  Single-row reads + writes don't need the join because
-- the upstream handler already has the anilist context.

-- name: ListUserSubscriptions :many
-- /api/subscriptions — list every subscription for one user, joined to
-- anime_cache for the listing-card columns the frontend needs.
-- Optional status filter:  when status is NULL the WHERE clause is a
-- tautology; passing a literal status filters to that bucket.
-- LEFT JOIN preserves rows even if anime_cache was cleared (unlikely
-- given ON DELETE CASCADE, but defensive).
SELECT
    s.user_id,
    s.anilist_id,
    s.status,
    s.current_episode,
    s.score,
    s.last_watched_at,
    s.created_at  AS subscribed_at,
    s.updated_at,
    a.title_romaji,
    a.title_english,
    a.title_native,
    a.title_chinese,
    a.title_hant,
    a.title_hant_source,
    a.title_hant_seo,
    a.cover_image_url,
    a.banner_image_url,
    a.cover_image_color,
    a.poster_accent,
    a.episodes,
    -- Inferred total (migration 0023).  Carried alongside `episodes`, never
    -- coalesced into it: the continue-watching card needs SOME denominator to
    -- draw a fraction and a progress bar, and for an airing show AniList
    -- routinely has none -- which is exactly the population this row is most
    -- likely to be about.  Without it the card falls back to printing the
    -- current episode alone, so "7" reads as a total when it is a position.
    --
    -- Two separate columns for the same reason as everywhere else: an inferred
    -- count may inform what a person sees and must never inform what a machine
    -- is told.  Nothing on this path reaches structured data today, and this
    -- shape is what keeps that true if something later does.
    a.episodes_bgm,
    a.season,
    a.season_year,
    a.format,
    a.status        AS anime_status
FROM subscriptions s
LEFT JOIN anime_cache a ON a.anilist_id = s.anilist_id
WHERE s.user_id = $1
  AND (sqlc.narg('status_filter')::text IS NULL OR s.status = sqlc.narg('status_filter')::text)
ORDER BY s.updated_at DESC;

-- name: GetSubscription :one
-- /api/subscriptions/:anilistId — single subscription read.
-- pgx.ErrNoRows → 404 "Subscription not found".
--
-- watched_episodes is the per-episode set (migration 0024), read in the
-- SAME statement as current_episode rather than in a second round-trip.
-- The two are one fact stated twice — current_episode is
-- COALESCE(MAX(episode), 0) over exactly this array — and a client that
-- receives them disagreeing draws a grid whose last checkmark contradicts
-- the progress number printed beside it.  Two queries against the pool can
-- straddle a concurrent mark and do exactly that; one statement cannot.
--
-- COALESCE to '{}' rather than letting array_agg's NULL through: a
-- subscriber with no marks has an empty set, not an unknown one, and the
-- endpoint is contracted to emit [] and never null.
--
-- Only the single-row read carries the array.  ListUserSubscriptions
-- deliberately does not: the card it feeds renders the derived integer and
-- nothing else, so attaching a set to every row in the list would be
-- bandwidth spent on a value no consumer reads.
SELECT
    s.user_id,
    s.anilist_id,
    s.status,
    s.current_episode,
    s.score,
    s.last_watched_at,
    s.created_at,
    s.updated_at,
    COALESCE(
        (
            SELECT array_agg(ew.episode ORDER BY ew.episode)
            FROM episode_watches ew
            WHERE ew.user_id = s.user_id
              AND ew.anilist_id = s.anilist_id
        ),
        '{}'
    )::integer[] AS watched_episodes
FROM subscriptions s
WHERE s.user_id = $1
  AND s.anilist_id = $2;

-- name: ListWatchedEpisodes :many
-- The watched set for one (user, anime), ascending.
--
-- No HTTP handler calls this: GetSubscription and both writes already
-- return the set from inside their own statement, which is the point of
-- how they are written.  It exists as the plain read of the table for
-- callers that want the set on its own — today that is the package's
-- tests, which use it to check what a write STORED rather than trusting
-- what the same write RETURNED.
--
-- WHERE user_id = $1 AND anilist_id = $2 ORDER BY episode is the primary
-- key's leading columns in the primary key's order, so this is a range
-- scan over the PK index that comes back already sorted — which is why
-- migration 0024 adds no secondary index.
SELECT episode
FROM episode_watches
WHERE user_id = $1
  AND anilist_id = $2
ORDER BY episode;

-- name: UpsertSubscription :one
-- POST /api/subscriptions — create-or-update on (user_id, anilist_id).
-- Caller MUST have ensured anime_cache row exists (else the FK kicks).
-- ON CONFLICT only writes status — Express also only patches `status`
-- in the upsert payload, leaving current_episode/score untouched on
-- re-add.  RETURNING gives the canonical post-write state.
INSERT INTO subscriptions (user_id, anilist_id, status, updated_at)
VALUES ($1, $2, $3, now())
ON CONFLICT (user_id, anilist_id) DO UPDATE
SET status     = EXCLUDED.status,
    updated_at = now()
RETURNING
    user_id,
    anilist_id,
    status,
    current_episode,
    score,
    last_watched_at,
    created_at,
    updated_at;

-- name: InsertSubscriptionIfAbsent :one
-- POST /api/subscriptions with `"ifAbsent": true` — the click-to-track path.
--
-- UpsertSubscription above is wrong for this caller: its
-- ON CONFLICT DO UPDATE SET status resurrects a title the user deliberately
-- marked dropped/completed back into `watching` the moment anything touches
-- it.  §4 decision 3: creation is idempotent and `status` is human-only.
--
-- ON CONFLICT DO NOTHING returns zero rows on conflict, so the UNION ALL arm
-- reads the pre-existing row back and returns it untouched.  The NOT EXISTS
-- guard keeps the two arms mutually exclusive (same idiom as
-- InsertNotificationIfAbsent in community.sql and InsertReport in safety.sql).
--
-- Caller MUST have ensured the anime_cache row exists (else the FK kicks).
WITH inserted AS (
    INSERT INTO subscriptions (user_id, anilist_id, status, updated_at)
    VALUES (
        sqlc.arg('user_id')::uuid,
        sqlc.arg('anilist_id')::integer,
        sqlc.arg('status')::text,
        now()
    )
    ON CONFLICT (user_id, anilist_id) DO NOTHING
    RETURNING
        user_id,
        anilist_id,
        status,
        current_episode,
        score,
        last_watched_at,
        created_at,
        updated_at
)
SELECT
    user_id,
    anilist_id,
    status,
    current_episode,
    score,
    last_watched_at,
    created_at,
    updated_at
FROM inserted
UNION ALL
SELECT
    existing.user_id,
    existing.anilist_id,
    existing.status,
    existing.current_episode,
    existing.score,
    existing.last_watched_at,
    existing.created_at,
    existing.updated_at
FROM subscriptions existing
WHERE existing.user_id = sqlc.arg('user_id')::uuid
  AND existing.anilist_id = sqlc.arg('anilist_id')::integer
  AND NOT EXISTS (SELECT 1 FROM inserted)
LIMIT 1;

-- name: UpdateSubscriptionWithActivity :one
-- Lock the previous value, apply the selective update, and append a watch event
-- only when the caller supplied a genuinely different episode.  This prevents
-- retries/status-only patches from manufacturing duplicate feed entries.
--
-- current_episode IS NOT WRITTEN BY THIS STATEMENT'S CALLER
-- ========================================================
--
-- Since migration 0024 the watched set is the stored fact and
-- current_episode is COALESCE(MAX(episode), 0) over it — on EVERY path,
-- with no exceptions.  So this statement does not accept a new
-- current_episode; it accepts an episode to RECORD, writes that one row,
-- and then reads the derived value back out of the set.
--
-- The monotonic guarantee falls out of the data instead of being enforced
-- by a comparison, and it is a stronger guarantee for it:
--
--   push 12 while at 7   → insert 12 → MAX is 12.  Progress advances.
--   replay 3 while at 12 → insert 3  → MAX is still 12, because 12 is
--                          still in the set.  Progress holds.
--
-- Nothing was removed, so nothing can go backwards.  That beats the old
-- GREATEST, which held only as long as every caller remembered to set the
-- flag — a caller who forgot could claw a phone's episode 12 back to 5
-- (§4 decision 8; Mihon #1793).  Now they cannot, flag or no flag.
--
-- CONSEQUENCES, INTENDED
-- ----------------------
--
--   * A non-monotonic PATCH can no longer LOWER current_episode.  Sending
--     a smaller number just records that episode; the maximum is unmoved.
--     This is not a regression to route around: the value is derived now,
--     so a caller writing it directly is asserting something the data does
--     not support.  Lowering is UNMARKING, and it has its own endpoint —
--     DELETE /api/subscriptions/:anilistId/episodes/:episode — which
--     removes the row and lets the recompute fall.  See
--     UnmarkEpisodeWatched.
--
--   * currentEpisode = 0 no longer means "reset to unwatched".  Zero is not
--     an episode, so it inserts nothing and the set is unchanged, so the
--     derived value is unchanged.  A true reset is deleting the marks.
--     Nothing in the application sends 0 today (checked: the only
--     currentEpisode writer is the library reconciler at
--     watchSync.ts:441, which sends a real high-water episode; every other
--     mention is a read with a `?? 0` default or a `> 0` display guard).
--
--   * An episode outside 1..5000 records nothing and therefore moves
--     nothing.  BETWEEN filters rather than rejects on purpose: an
--     out-of-range value must not turn an otherwise valid PATCH into a
--     constraint violation the caller sees as a 500.  Because the value is
--     derived, this can no longer leave progress and the set disagreeing
--     the way a direct write would — the row simply does not change.
--
-- WHAT `monotonic` STILL DOES
-- ---------------------------
--
-- It no longer selects the progress semantics — there is only one now.  Its
-- single remaining reader is the updated_at suppression below.  The flag is
-- kept in the request body rather than removed in the same change that
-- demoted it, so that the reconciler keeps working untouched and the
-- removal can be judged on its own.
--
-- ONE EPISODE, NEVER 1..N
-- -----------------------
--
-- The inserted row is the episode the caller is RECORDING, and only that
-- one.  Writing 1..N here would re-create exactly the inference this whole
-- feature exists to delete: a player that finishes episode 12 observed
-- episode 12 and says nothing about 1-11.  A user who then clicks 1, 2 and
-- 3 ends up with {1,2,3,12} and current_episode still 12.
--
-- No guard on "did anything change".  ON CONFLICT DO NOTHING already makes
-- a repeat a no-op, and leaving it unguarded is what lets a replay REPAIR a
-- set missing a row it should have had.
--
-- THE TWO TIMESTAMPS
-- ------------------
--
--   last_watched_at  Semantic honesty.  The column means "an episode was
--                    watched", so it moves exactly when a new mark landed —
--                    EXISTS (SELECT 1 FROM inserted_watch) — and not when a
--                    replay re-asserts something already recorded.  This is
--                    the same rule MarkEpisodeWatched uses, deliberately:
--                    one table, one meaning, one condition.
--
--   updated_at       This is the one the home page sees.
--                    ListUserSubscriptions above is ORDER BY
--                    s.updated_at DESC and ContinueWatching renders that
--                    order verbatim, so bumping it on a push that changed
--                    nothing would jump an untouched show to the front of
--                    the user's list.  ⚠️ If you ever change that ORDER BY,
--                    this CASE is why it was safe to suppress here.
--
-- updated_at's guard checks two more fields than last_watched_at's: a
-- monotonic PATCH may legally also carry status or score (the reconciler
-- never sends those, but the endpoint accepts them), and those ARE real
-- edits that must bump the row.  Only a push that changes literally nothing
-- is preserved.  Note the asymmetry this produces on a repair — a replay
-- that fills in a missing mark moves last_watched_at but not updated_at.
-- That is intended: repairing history is not the same event as watching
-- something, and it must not reorder the list.
--
WITH previous AS (
    SELECT s.user_id, s.anilist_id, s.current_episode
    FROM subscriptions s
    WHERE s.user_id = sqlc.arg('user_id')::uuid
      AND s.anilist_id = sqlc.arg('anilist_id')::integer
    FOR UPDATE
), inserted_watch AS (
    -- Reads its keys from `previous`, so a caller with no subscription
    -- writes nothing and the statement returns no rows (handler: 404).
    INSERT INTO episode_watches (user_id, anilist_id, episode)
    SELECT p.user_id, p.anilist_id, sqlc.narg('current_episode')::integer
    FROM previous p
    WHERE sqlc.narg('current_episode')::integer BETWEEN 1 AND 5000
    ON CONFLICT (user_id, anilist_id, episode) DO NOTHING
    RETURNING episode
), watched AS (
    -- The UNION is not optional.  Every CTE in a statement sees the
    -- snapshot taken before the statement ran, so the plain SELECT cannot
    -- see the row `inserted_watch` just wrote; without it, recording a new
    -- highest episode would derive a current_episode one episode short of
    -- the set it is supposed to summarise.
    SELECT ew.episode
    FROM episode_watches ew
    WHERE ew.user_id = sqlc.arg('user_id')::uuid
      AND ew.anilist_id = sqlc.arg('anilist_id')::integer
    UNION
    SELECT i.episode FROM inserted_watch i
), updated AS (
    UPDATE subscriptions subscription
    SET
        status = COALESCE(sqlc.narg('status'), subscription.status),
        -- Derived, unconditionally, on every path.  No GREATEST, no
        -- COALESCE-to-the-old-value, no monotonic branch: the set is the
        -- only writer of this number, so there is nothing here to disagree
        -- with it.  Recomputing when the caller sent no episode at all is
        -- free (the value cannot have moved) and self-healing.
        current_episode = (SELECT COALESCE(MAX(w.episode), 0) FROM watched w),
        score = CASE
                    WHEN sqlc.arg('score_set')::boolean
                        THEN sqlc.narg('score')::integer
                    ELSE subscription.score
                END,
        last_watched_at = CASE
                              WHEN EXISTS (SELECT 1 FROM inserted_watch)
                                  THEN now()
                              ELSE subscription.last_watched_at
                          END,
        updated_at = CASE
                         WHEN sqlc.arg('monotonic')::boolean
                              AND sqlc.narg('status') IS NULL
                              AND NOT sqlc.arg('score_set')::boolean
                              AND (SELECT COALESCE(MAX(w.episode), 0) FROM watched w)
                                  IS NOT DISTINCT FROM subscription.current_episode
                             THEN subscription.updated_at
                         ELSE now()
                     END
    FROM previous
    WHERE subscription.user_id = sqlc.arg('user_id')::uuid
      AND subscription.anilist_id = sqlc.arg('anilist_id')::integer
    RETURNING subscription.*, previous.current_episode AS previous_episode
), inserted_activity AS (
    INSERT INTO activity_events (user_id, event_type, anilist_id, episode)
    SELECT
        user_id,
        'watch_progress',
        anilist_id,
        current_episode
    FROM updated
    WHERE sqlc.narg('current_episode')::integer IS NOT NULL
      AND current_episode IS DISTINCT FROM previous_episode
    RETURNING id
)
SELECT
    user_id,
    anilist_id,
    status,
    current_episode,
    score,
    last_watched_at,
    created_at,
    updated_at
FROM updated;

-- name: UpdateSubscription :one
-- PATCH /api/subscriptions/:anilistId — selective update.
-- COALESCE pattern keeps unchanged columns untouched.  `last_watched_at`
-- only bumps when current_episode is explicitly set, matching Express
-- behaviour (only the current_episode mutation refreshes the watch
-- timestamp; status changes don't).  Score is clamped to [1,10] by the
-- application layer, not here — the DB constraint enforces it but
-- silently rejecting clamps would surprise the caller.
UPDATE subscriptions
SET
    status          = COALESCE(sqlc.narg('status'), status),
    current_episode = COALESCE(sqlc.narg('current_episode')::integer, current_episode),
    score           = CASE
                          WHEN sqlc.arg('score_set')::boolean THEN sqlc.narg('score')::integer
                          ELSE score
                      END,
    last_watched_at = CASE
                          WHEN sqlc.narg('current_episode')::integer IS NOT NULL THEN now()
                          ELSE last_watched_at
                      END,
    updated_at      = now()
WHERE user_id   = sqlc.arg('user_id')::uuid
  AND anilist_id = sqlc.arg('anilist_id')::integer
RETURNING
    user_id,
    anilist_id,
    status,
    current_episode,
    score,
    last_watched_at,
    created_at,
    updated_at;

-- name: DeleteSubscription :execrows
-- DELETE /api/subscriptions/:anilistId.  Returns the affected row count
-- so the handler can 404 when no row matched (matches Express's
-- findOneAndDelete returning null → 404 "Subscription not found").
DELETE FROM subscriptions
WHERE user_id = $1
  AND anilist_id = $2;

-- -----------------------------------------------------------------------------
-- Per-episode watch marks (migration 0024)
-- -----------------------------------------------------------------------------
--
-- Two writers, one shape.  Both are a SINGLE statement, and that is the
-- whole design constraint rather than a stylistic preference: the watch row
-- and the derived subscriptions.current_episode are the same fact recorded
-- twice, so any arrangement in which one can commit without the other —
-- including a perfectly ordinary handler-side transaction with an error
-- path between the two calls — can leave the integer and the set
-- disagreeing.  Inside one statement they cannot.
--
-- THESE ARE THE ONLY WAY PROGRESS COMES DOWN
-- ==========================================
--
-- current_episode is COALESCE(MAX(episode), 0) over this table on every
-- path, so no PATCH can lower it — writing a smaller number just records
-- that episode, and the maximum is unmoved because nothing was removed.
-- Removing something is what these two statements do, and unmarking is
-- therefore the only operation in the system that can make the number fall.
--
-- That is the correct place for it.  A person unchecking a box is saying
-- "I did not watch that", which is a statement about the set; the number
-- follows because it is derived from the set.  The old arrangement had a
-- `monotonic` flag choosing between "may go down" and "may not", which put
-- the guarantee in the hands of every caller remembering to set it.  Now
-- the guarantee is structural: a replay adds, and adding cannot lower a
-- maximum.
--
-- Do NOT reintroduce a comparison here to stop the value falling.  There is
-- no stale-replay risk on this path — a replayed DELETE removes an episode
-- the user already asked to remove — and a guard would make the grid a
-- read-only decoration, since unmarking would then be unable to correct the
-- over-count it exists to correct.
--
-- Neither writer appends an activity_events row.  Marking one episode is
-- not a feed-worthy event and a per-checkbox feed entry would bury the
-- watch_progress events that are; UpdateSubscriptionWithActivity remains
-- the only producer of that event type.

-- name: MarkEpisodeWatched :one
-- PUT /api/subscriptions/:anilistId/episodes/:episode — idempotent.
--
-- `target` is the authorization and existence gate in one: everything
-- downstream reads its (user_id, anilist_id) from a subscription row that
-- was proven to belong to the caller, so a request naming somebody else's
-- anime writes nothing and the statement returns zero rows.  Marking an
-- episode of an anime with no subscription is the same zero-row case — the
-- handler answers 404 rather than inventing a subscription, because
-- creating one would mean choosing a `status` the user never picked (§4
-- decision 3 makes status human-only) and would also require the
-- anime_cache row to exist, which is an AniList round-trip nobody expects
-- behind a checkbox click.
--
-- FOR UPDATE serializes against UpdateSubscriptionWithActivity, which
-- takes the same lock on the same row in the same order — so a ± press and
-- a checkbox click cannot interleave halfway.
--
-- The UNION in `watched` is not optional.  Every CTE in a statement sees
-- the snapshot taken before the statement ran, so the plain SELECT over
-- episode_watches cannot see the row `inserted` just wrote; without the
-- UNION, marking a new highest episode would compute a current_episode one
-- episode short of the set it is supposed to summarise.  ON CONFLICT DO
-- NOTHING makes `inserted` empty on a repeat mark, and the UNION is then a
-- no-op — which is exactly what idempotent has to mean here.
--
-- current_episode is rewritten unconditionally (a recompute to the same
-- value is free, and it repairs a row whose derived value has drifted),
-- but the two timestamps only move when the set actually changed.
-- last_watched_at means "an episode was watched" and a repeat mark watched
-- nothing; updated_at is what ListUserSubscriptions orders on, so bumping
-- it on a no-op would jump an untouched show to the front of the user's
-- continue-watching row.  Same reasoning, same two reasons, as the
-- suppression in UpdateSubscriptionWithActivity.
WITH target AS (
    SELECT s.user_id, s.anilist_id
    FROM subscriptions s
    WHERE s.user_id = sqlc.arg('user_id')::uuid
      AND s.anilist_id = sqlc.arg('anilist_id')::integer
    FOR UPDATE
), inserted AS (
    INSERT INTO episode_watches (user_id, anilist_id, episode)
    SELECT t.user_id, t.anilist_id, sqlc.arg('episode')::integer
    FROM target t
    ON CONFLICT (user_id, anilist_id, episode) DO NOTHING
    RETURNING episode
), watched AS (
    SELECT ew.episode
    FROM episode_watches ew
    WHERE ew.user_id = sqlc.arg('user_id')::uuid
      AND ew.anilist_id = sqlc.arg('anilist_id')::integer
    UNION
    SELECT i.episode FROM inserted i
), recomputed AS (
    UPDATE subscriptions s
    SET current_episode = (SELECT COALESCE(MAX(w.episode), 0) FROM watched w),
        last_watched_at = CASE
                              WHEN EXISTS (SELECT 1 FROM inserted) THEN now()
                              ELSE s.last_watched_at
                          END,
        updated_at      = CASE
                              WHEN EXISTS (SELECT 1 FROM inserted) THEN now()
                              ELSE s.updated_at
                          END
    FROM target t
    WHERE s.user_id = t.user_id
      AND s.anilist_id = t.anilist_id
    RETURNING s.current_episode
)
SELECT
    COALESCE(
        (SELECT array_agg(w.episode ORDER BY w.episode) FROM watched w),
        '{}'
    )::integer[] AS watched_episodes,
    r.current_episode
FROM recomputed r;

-- name: MarkEpisodesWatched :one
-- PUT /api/subscriptions/:anilistId/episodes — mark a SET, idempotently.
--
-- Same statement as MarkEpisodeWatched with `unnest` in place of the single
-- literal, and it exists for one reason: the library reconciler pushes the
-- episodes a reader's local library knows about, and a first sync of a
-- two-cour series is fifty of them.  Fifty round trips behind one page mount,
-- against a per-IP rate limiter, is not a thing to ship — so the set travels
-- in one statement, and therefore in one lock, one recompute and one feed
-- event.
--
-- IT UNIONS.  IT NEVER REPLACES.
-- =============================
--
-- The caller sends the episodes IT knows about, which is not the same thing
-- as the episodes that exist.  A reader with two devices, or one device and
-- the website's grid, has marks this caller has never heard of; a replace
-- would delete them and there would be no record that it had.  INSERT ...
-- ON CONFLICT DO NOTHING is the whole guarantee: the set can only grow here.
-- Removing a mark is UnmarkEpisodeWatched, one episode at a time, because
-- removal is always a deliberate act and never a side effect of a sync.
--
-- Duplicates in the array are fine and are not an error.  ON CONFLICT DO
-- NOTHING resolves a duplicate against the row the same statement just
-- speculatively inserted, exactly as it resolves one against a row that was
-- already there.  (DO UPDATE would raise "cannot affect row a second time";
-- DO NOTHING does not.)  So the handler validates members for VALIDITY and
-- says nothing about tidiness.
--
-- Out-of-range members are rejected by the handler and never arrive, so —
-- unlike UpdateSubscriptionWithActivity, which filters them with a BETWEEN —
-- there is nothing to filter here.  The difference is deliberate: a PATCH
-- carrying a bad episode may still be a legitimate status or score edit and
-- must not 500, whereas this endpoint's entire body IS the episode list, so a
-- bad member makes the whole request meaningless and it is answered 400.
--
-- The activity event is the one part that does NOT mirror MarkEpisodeWatched,
-- and the reason is in the note above those two: a per-checkbox feed entry
-- would bury the watch_progress events worth reading.  This is not a
-- checkbox.  It is the same "the reader got further" event PATCH has always
-- written, arriving by a different door, so it writes at most ONE event and
-- only when current_episode actually advanced — the identical condition
-- UpdateSubscriptionWithActivity uses.  Without it, moving the reconciler off
-- PATCH would empty the feed with no error, which is precisely the failure
-- the SubscriptionsDB comment warns about for the plain UpdateSubscription.
--
-- Both timestamps follow MarkEpisodeWatched's rule, for MarkEpisodeWatched's
-- reasons: they move only when the set actually changed, so a replayed push
-- neither claims a viewing that did not happen nor reorders the home page's
-- continue-watching row.
WITH target AS (
    SELECT s.user_id, s.anilist_id, s.current_episode AS previous_episode
    FROM subscriptions s
    WHERE s.user_id = sqlc.arg('user_id')::uuid
      AND s.anilist_id = sqlc.arg('anilist_id')::integer
    FOR UPDATE
), inserted AS (
    -- Reads its keys from `target`, so a caller with no subscription writes
    -- nothing and the statement returns no rows (handler: 404).  The
    -- composite FK says the same thing at the storage layer.
    INSERT INTO episode_watches (user_id, anilist_id, episode)
    SELECT t.user_id, t.anilist_id, e.episode
    FROM target t
    CROSS JOIN unnest(sqlc.arg('episodes')::integer[]) AS e(episode)
    ON CONFLICT (user_id, anilist_id, episode) DO NOTHING
    RETURNING episode
), watched AS (
    -- The UNION is not optional, for the snapshot reason spelled out on
    -- MarkEpisodeWatched: the plain SELECT cannot see rows this statement
    -- just wrote, so without it a push that records a new highest episode
    -- would derive a current_episode short of the set it summarises.
    SELECT ew.episode
    FROM episode_watches ew
    WHERE ew.user_id = sqlc.arg('user_id')::uuid
      AND ew.anilist_id = sqlc.arg('anilist_id')::integer
    UNION
    SELECT i.episode FROM inserted i
), recomputed AS (
    UPDATE subscriptions s
    SET current_episode = (SELECT COALESCE(MAX(w.episode), 0) FROM watched w),
        last_watched_at = CASE
                              WHEN EXISTS (SELECT 1 FROM inserted) THEN now()
                              ELSE s.last_watched_at
                          END,
        updated_at      = CASE
                              WHEN EXISTS (SELECT 1 FROM inserted) THEN now()
                              ELSE s.updated_at
                          END
    FROM target t
    WHERE s.user_id = t.user_id
      AND s.anilist_id = t.anilist_id
    RETURNING s.user_id, s.anilist_id, s.current_episode, t.previous_episode
), inserted_activity AS (
    INSERT INTO activity_events (user_id, event_type, anilist_id, episode)
    SELECT r.user_id, 'watch_progress', r.anilist_id, r.current_episode
    FROM recomputed r
    WHERE r.current_episode IS DISTINCT FROM r.previous_episode
    RETURNING id
)
SELECT
    COALESCE(
        (SELECT array_agg(w.episode ORDER BY w.episode) FROM watched w),
        '{}'
    )::integer[] AS watched_episodes,
    r.current_episode
FROM recomputed r;

-- name: UnmarkEpisodeWatched :one
-- DELETE /api/subscriptions/:anilistId/episodes/:episode — idempotent.
--
-- Mirror of MarkEpisodeWatched, including the `target` gate and its FOR
-- UPDATE.  Unmarking an episode that was never marked is not an error: the
-- caller asked for a state and got it, and 404-ing on it would make the UI
-- have to know the current set before it can act on it.
--
-- EXCEPT plays the role UNION plays above and for the same snapshot
-- reason: the SELECT over episode_watches still sees the row `deleted`
-- removed, so subtracting it is what makes the recompute describe the set
-- as it will be rather than as it was.  Removing the highest mark is the
-- case that matters — that is when current_episode has to fall, including
-- all the way to 0 when the last mark goes.
--
-- last_watched_at is NOT touched here, under any condition.  Un-checking a
-- box is a correction, not a viewing: the column means "when an episode was
-- actually watched", and no episode was.  updated_at does move, because
-- the row genuinely changed and the list order should reflect a deliberate
-- edit — but only when something was actually deleted.
WITH target AS (
    SELECT s.user_id, s.anilist_id
    FROM subscriptions s
    WHERE s.user_id = sqlc.arg('user_id')::uuid
      AND s.anilist_id = sqlc.arg('anilist_id')::integer
    FOR UPDATE
), deleted AS (
    DELETE FROM episode_watches ew
    USING target t
    WHERE ew.user_id = t.user_id
      AND ew.anilist_id = t.anilist_id
      AND ew.episode = sqlc.arg('episode')::integer
    RETURNING ew.episode
), watched AS (
    SELECT ew.episode
    FROM episode_watches ew
    WHERE ew.user_id = sqlc.arg('user_id')::uuid
      AND ew.anilist_id = sqlc.arg('anilist_id')::integer
    EXCEPT
    SELECT d.episode FROM deleted d
), recomputed AS (
    UPDATE subscriptions s
    SET current_episode = (SELECT COALESCE(MAX(w.episode), 0) FROM watched w),
        updated_at      = CASE
                              WHEN EXISTS (SELECT 1 FROM deleted) THEN now()
                              ELSE s.updated_at
                          END
    FROM target t
    WHERE s.user_id = t.user_id
      AND s.anilist_id = t.anilist_id
    RETURNING s.current_episode
)
SELECT
    COALESCE(
        (SELECT array_agg(w.episode ORDER BY w.episode) FROM watched w),
        '{}'
    )::integer[] AS watched_episodes,
    r.current_episode
FROM recomputed r;

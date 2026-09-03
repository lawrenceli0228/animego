-- Queries for /api/admin/* (P2.3).
--
-- Most admin reads are single-row aggregates or list-by-version batches.
-- ListEnrichment + ListAdminUsers are intentionally NOT here because they
-- need dynamic ORDER BY + filter composition that sqlc cannot express
-- without an explosion of query variants — those run as raw pgxpool
-- queries in internal/admin/list.go with a column-name allow-list.
--
-- Conventions:
--   * count() cast to ::bigint so sqlc generates int64 (matching Express's
--     JS Number which is int64-safe up to 2^53).
--   * Selective UPDATE uses COALESCE($1, column) only when the field is
--     *string and "nil means skip" semantics apply.  Setting a field to
--     NULL on purpose uses a pgtype.Text wrapper in the handler.
--   * RETURNING the projection columns matches Express's .select() shape.

-- name: GetAdminStats :one
-- /api/admin/stats — COUNT()s in a single round-trip.
-- Replaces Promise.all() of 10 Mongo countDocuments calls.  All counts
-- run as correlated subqueries so we get one row, one fetch.
SELECT
    (SELECT count(*) FROM users)::bigint                                                              AS total_users,
    (SELECT count(*) FROM anime_cache)::bigint                                                        AS total_anime,
    (SELECT count(*) FROM anime_cache WHERE bangumi_version = 0)::bigint                              AS enrich_v0,
    (SELECT count(*) FROM anime_cache WHERE bangumi_version = 1)::bigint                              AS enrich_v1,
    (SELECT count(*) FROM anime_cache WHERE bangumi_version = 2)::bigint                              AS enrich_v2,
    (SELECT count(*) FROM anime_cache WHERE bangumi_version >= 3)::bigint                             AS enrich_v3,
    (SELECT count(*) FROM anime_cache WHERE bgm_id IS NOT NULL AND title_chinese IS NULL)::bigint     AS no_cn,
    -- Honesty fields (P3/P4): real CN coverage + the "Heal CN can actually
    -- fix" count + the unhealable v3-no-cn + the by-source breakdown.
    (SELECT count(*) FROM anime_cache WHERE title_chinese IS NOT NULL)::bigint                        AS has_cn,
    (SELECT count(*) FROM anime_cache WHERE bgm_id IS NOT NULL AND bangumi_version = 2 AND title_chinese IS NULL)::bigint AS heal_cn_real,
    (SELECT count(*) FROM anime_cache WHERE bangumi_version >= 3 AND bgm_id IS NOT NULL AND title_chinese IS NULL)::bigint AS cn_stuck,
    -- Bindings upstream will not serve us (migration 0031).  These rows are
    -- terminal by design, so no button acts on this number -- it is here
    -- because without it they are indistinguishable from healthy v3 rows,
    -- and "how many bindings can we not read" is the question a Bangumi
    -- token would be bought to answer.
    (SELECT count(*) FROM anime_cache WHERE bangumi_subject_unreadable_at IS NOT NULL)::bigint AS subject_unreadable,
    (SELECT count(*) FROM anime_cache WHERE bgm_match_source = 'id_map')::bigint                      AS src_id_map,
    (SELECT count(*) FROM anime_cache WHERE bgm_match_source = 'fuzzy_high')::bigint                  AS src_fuzzy_high,
    (SELECT count(*) FROM anime_cache WHERE bgm_match_source = 'fuzzy_low')::bigint                   AS src_fuzzy_low,
    (SELECT count(*) FROM anime_cache WHERE admin_flag IS NOT NULL)::bigint                           AS flagged,
    (SELECT count(*) FROM subscriptions)::bigint                                                      AS total_subs,
    (SELECT count(*) FROM follows)::bigint                                                            AS total_follows;

-- name: GetDescriptionCnStats :one
-- Chinese-description backfill coverage (P3) — the four numbers behind the
-- /admin 中文简介回填 block.
--
-- WHY THIS IS A SEPARATE QUERY AND NOT FOUR MORE COLUMNS ON GetAdminStats:
-- every count below reads description_cn_eligible, a VIEW created by
-- migration 0016.  Folded into GetAdminStats, any problem with that view —
-- migration not yet applied on a rolled-forward container, a `migrate down`,
-- a statement timeout on the widest scan in the payload — takes the ENTIRE
-- stats response down with it, and the admin page loses users, anime,
-- enrichment, queue and flags along with the backfill block it was never
-- asked about.  Verified, not theorised:  dropping the view makes the fused
-- SELECT fail outright with `relation "description_cn_eligible" does not
-- exist`, because a missing relation is a planning error and no amount of
-- per-column care survives it.  Split out, the handler soft-fails this one
-- call (see read.go) and everything else still renders.  The least critical
-- panel on the page must not be able to blank the page.
--
-- All four read the view, never anime_cache directly.  That view is the
-- single definition of "this row's Bangumi binding is trustworthy enough to
-- copy a synopsis from", and the sweep's candidate query
-- (ListDescriptionCnCandidates) plus the writer's guard (UpdateDescriptionCn)
-- both read it too.  Re-deriving the predicate here would let the dashboard
-- drift away from what the sweep actually does — and a wrong number that
-- still looks authoritative is worse than no number.
--
-- The model is coverage, not batch progress:  the sweep is perpetual, so
-- there is no "total to process" that ever reaches 100%.  done/eligible is
-- the honest headline.
--
-- desc_cn_rejected and desc_cn_pending deliberately OVERLAP:  a row decided
-- against longer ago than the cooldown is both "we tried and got nothing" and
-- "the sweep will reach it again".  They answer different questions (how much
-- has upstream already refused us / how much work is live) and must not be
-- summed.  eligible = done + (rows with no CN), and that second term is what
-- rejected and pending each slice differently.
SELECT
    (SELECT count(*) FROM description_cn_eligible)::bigint                                            AS desc_cn_eligible,
    (SELECT count(*) FROM description_cn_eligible WHERE description_cn IS NOT NULL)::bigint           AS desc_cn_done,
    -- "Attempted and still empty".  NOT purely the language gate, despite
    -- being the metric an operator will read as such — DescriptionBackfillWorker
    -- stamps description_cn_attempted_at on every DECIDED outcome, and there
    -- are four of those:  Bangumi has no summary at all, the summary failed
    -- bangumi.CleanSummary's Chinese check, the subject 404'd (ErrNotFound —
    -- a stale binding), or the UPDATE itself errored and was swallowed.  Only
    -- transient fetch failures escape the stamp, because those return an error
    -- and go to river's retry path instead.
    --
    -- This matters for reading a spike:  a mass 404 or a broken writer produces
    -- NO retryable jobs (the worker returns nil in both cases), so the queue
    -- block stays green and this counter is the only place the breakage shows.
    -- Rejected climbing while done is flat is a signal to check the logs, not
    -- something to wave away as "Bangumi is Japanese-only".
    (SELECT count(*) FROM description_cn_eligible
      WHERE description_cn IS NULL
        AND description_cn_attempted_at IS NOT NULL)::bigint                                          AS desc_cn_rejected,
    -- The '30 days' literal MUST stay equal to descriptionBackfillRetryDays in
    -- internal/queue/description_backfill.go — that constant is what actually
    -- bounds ListDescriptionCnCandidates.  sqlc cannot read a Go const, so this
    -- is a hand-kept mirror:  if the two diverge, the dashboard's "pending"
    -- counts a different set of rows than the sweep will pick up, and the panel
    -- either shows work that never gets scheduled (literal too small) or hides
    -- work that is already queued (literal too large).  Change one, change both.
    --
    -- Note this is the whole live backlog, deliberately NOT capped at
    -- descriptionBackfillScanBatchSize:  the batch size throttles one pass, it
    -- does not define how much is outstanding.  Capping here would make the
    -- backlog look permanently 300-deep no matter how far behind it really is.
    -- The description_cn_source = 'llm' arm mirrors the same widening in
    -- ListDescriptionCnCandidates (machine-translated rows return to the
    -- Bangumi sweep's 30-day re-check so human prose can replace them).
    -- Change one, change both.
    (SELECT count(*) FROM description_cn_eligible
      WHERE (description_cn IS NULL OR description_cn_source = 'llm')
        AND (
            description_cn_attempted_at IS NULL
            OR description_cn_attempted_at < now() - interval '30 days'
        ))::bigint                                                                                    AS desc_cn_pending;

-- name: GetDescriptionCnLlmStats :one
-- LLM translation tier coverage — the four numbers behind the /admin
-- 机翻兜底 block.
--
-- A THIRD separate query, for the same reason GetDescriptionCnStats is the
-- second: it reads description_cn_eligible (via NOT EXISTS) and must be able
-- to fail without taking the rest of the admin page — or the Bangumi block —
-- down with it.  Three soft-failing calls beat one fused SELECT whose
-- weakest dependency decides whether the operator sees anything at all.
--
-- THE DENOMINATOR IS NOT THE CATALOGUE.  The LLM tier's remit is strictly
-- Bangumi's leftovers, so `llm_remit` counts exactly the rows this sweep
-- could ever write:  an English source text exists, the row is either still
-- empty or already machine-translated, and the Bangumi channel is done with
-- it (attempt-stamped) or can never touch it (outside the trust view).  A
-- row Bangumi later fills with human prose leaves the remit on its own,
-- which is correct — it stops being this tier's business.
--
-- Each arm below mirrors ListDescriptionCnLlmCandidates in
-- internal/db/queries/anime_cache.sql.  The '30 days' literal MUST stay
-- equal to descriptionLlmRetryDays in internal/queue/description_llm_backfill.go
-- — sqlc cannot read a Go const, so this is a hand-kept mirror exactly like
-- the Bangumi block's.  Change one, change both.
--
-- llm_rejected and llm_pending OVERLAP by design, same as the Bangumi
-- block:  a row whose translation failed validation longer ago than the
-- cooldown is both "we tried and got nothing usable" and "the sweep will
-- reach it again".  They answer different questions and must not be summed.
--
-- Reading a spike:  DescriptionLlmWorker stamps on every DECIDED outcome
-- (validation rejected the output, the source stripped to nothing, or
-- Bangumi won the race between scan and work) but NOT on transport errors,
-- which return and go to river's retry path.  So llm_rejected climbing while
-- llm_done is flat means the model is returning text that fails the Han-density
-- or length gate — check the logs, do not wave it away.
SELECT
    (SELECT count(*) FROM anime_cache ac
      WHERE ac.description IS NOT NULL AND ac.description <> ''
        AND (ac.description_cn IS NULL OR ac.description_cn_source = 'llm')
        AND (
            ac.description_cn_attempted_at IS NOT NULL
            OR NOT EXISTS (
                SELECT 1 FROM description_cn_eligible e WHERE e.anilist_id = ac.anilist_id
            )
        ))::bigint                                                                                    AS llm_remit,
    (SELECT count(*) FROM anime_cache
      WHERE description_cn_source = 'llm')::bigint                                                    AS llm_done,
    (SELECT count(*) FROM anime_cache ac
      WHERE ac.description IS NOT NULL AND ac.description <> ''
        AND ac.description_cn IS NULL
        AND ac.description_cn_llm_attempted_at IS NOT NULL
        AND (
            ac.description_cn_attempted_at IS NOT NULL
            OR NOT EXISTS (
                SELECT 1 FROM description_cn_eligible e WHERE e.anilist_id = ac.anilist_id
            )
        ))::bigint                                                                                    AS llm_rejected,
    (SELECT count(*) FROM anime_cache ac
      WHERE ac.description IS NOT NULL AND ac.description <> ''
        AND ac.description_cn IS NULL
        AND (
            ac.description_cn_llm_attempted_at IS NULL
            OR ac.description_cn_llm_attempted_at < now() - interval '30 days'
        )
        AND (
            ac.description_cn_attempted_at IS NOT NULL
            OR NOT EXISTS (
                SELECT 1 FROM description_cn_eligible e WHERE e.anilist_id = ac.anilist_id
            )
        ))::bigint                                                                                    AS llm_pending;

-- name: GetAnimeCacheRowForReset :one
-- Read the row Reset will mutate.  Returns the projection columns the
-- handler needs to re-enqueue: anilist_id, title_native, title_romaji.
-- Errors out cleanly with pgx.ErrNoRows when the anime doesn't exist
-- (handler maps → 404).
SELECT
    anilist_id,
    title_native,
    title_romaji,
    bgm_id
FROM anime_cache
WHERE anilist_id = $1;

-- name: ResetAnimeEnrichment :exec
-- POST /api/admin/enrichment/:anilistId/reset — Express:
--   doc.bangumiVersion = 0
--   doc.titleChinese   = null
--   doc.bgmId          = null
--   doc.bangumiScore   = undefined
--   doc.bangumiVotes   = undefined
--   doc.adminFlag      = null
--   await doc.save()
--
-- characters/episode_titles also wiped in Express (doc.episodeTitles +
-- doc.characters undefined).  In PG those are separate tables — handler
-- runs the corresponding DELETE inside the same transaction so the
-- re-enqueue produces a fresh enrichment cycle.
--
-- The five episodes_bgm* columns (migration 0023) go with the bgm_id that
-- produced them.  A reset nulls bgm_id, so leaving an inferred count behind
-- would strand a number whose only provenance was the binding just thrown
-- away — and leave the sweep unable to notice, since 'ok' on a finished show
-- is a frozen state.  Clearing them puts the row back at
-- episodes_bgm_attempted_at IS NULL, i.e. at the front of the next sweep.
UPDATE anime_cache
SET
    bangumi_version = 0,
    title_chinese   = NULL,
    bgm_id          = NULL,
    bangumi_score   = NULL,
    bangumi_votes   = NULL,
    admin_flag      = NULL,
    bgm_match_source = NULL,
    episodes_bgm              = NULL,
    episodes_bgm_at           = NULL,
    episodes_bgm_attempted_at = NULL,
    episodes_bgm_outcome      = NULL,
    episodes_bgm_reason       = NULL,
    updated_at      = now()
WHERE anilist_id = $1;

-- name: FlagAnimeEnrichment :one
-- POST /api/admin/enrichment/:anilistId/flag — set admin_flag to one of
-- 'needs-review' / 'manually-corrected' / NULL.  CHECK constraint on the
-- column enforces the allow-list at DB level; handler also pre-validates
-- so the 400 message is friendly.
--
-- This statement deliberately does NOT clear the row's derived Bangumi data.
-- Repudiating a binding is ResetAnimeEnrichment's job, and changing one is
-- UpdateAnimeEnrichmentSelective's; flagging is triage, and triage must not
-- destroy anything.
--
-- The tempting version clears episodes_bgm* and deletes every
-- anime_episode_titles row on any flag write, on the theory that an
-- unnecessary clear only costs one Bangumi round-trip on the next sweep.  That
-- theory is false for almost every row it would touch.  The sweep's candidate
-- set is `episodes IS NULL` — a small minority of the catalogue.  For every
-- other row nothing ever re-derives the titles, so the real cost of an
-- unnecessary clear is a permanently empty episode list on a public, indexed
-- page, repairable only by an admin noticing and running a re-enrich.
--
-- The flag values make it worse, not better.  'needs-review' is written by
-- MarkBangumiNeedsReview as well as by humans, 'manually-corrected' arrives as
-- a side effect of every PATCH, and NULL is what dismissing a flag writes — so
-- clearing on all three means dismissing a false alarm blanks an episode list,
-- and a title-only correction blanks one too.
--
-- Nor would clearing make a suspected mis-binding correct.  The row keeps the
-- bgm_id that produced the bad titles; deleting them leaves the page empty
-- rather than right, and the human still has to reset or re-bind.  Reset
-- already deletes the title rows in its transaction, which is where the
-- "throw away what this binding produced" behaviour belongs.
UPDATE anime_cache
SET admin_flag = $2,
    updated_at = now()
WHERE anilist_id = $1
RETURNING
    anilist_id,
    title_romaji,
    title_chinese,
    bgm_id,
    bangumi_score,
    admin_flag;

-- name: UpdateAnimeEnrichmentSelective :one
-- PATCH /api/admin/enrichment/:anilistId — partial update.  COALESCE
-- pattern: pass NULL for fields the caller doesn't want to touch.  The
-- *string / *float64 / *int parameters serialize correctly via pgx; the
-- handler converts request body absent/present into nil/pointer.
--
-- admin_flag is always set to 'manually-corrected' as a side effect
-- (Express:  updates.adminFlag = 'manually-corrected').
--
-- When — and ONLY when — this PATCH moves bgm_id, everything derived from the
-- old binding is repudiated in the same statement: the five episodes_bgm*
-- columns and every episode-title row.  See FlagAnimeEnrichment for why the
-- title DELETE is unconditional over the table rather than selective (no
-- provenance column exists, and none is needed: every row in it comes from
-- /subject/{bgm_id}/ep) and why ON CONFLICT DO UPDATE cannot repair a
-- too-long list on its own.
--
-- The condition is narrower here than on the flag endpoint on purpose: this
-- statement knows exactly what changed, and a PATCH that only rewrites
-- title_chinese has said nothing about the binding, so its derived values are
-- still validly derived.  `rebound` reads the pre-UPDATE bgm_id because every
-- CTE in a statement sees the same snapshot.
--
-- Nulling episodes_bgm_attempted_at rather than recording a rejection is what
-- puts the row back at the FRONT of ListEpisodesBgmCandidates, so an admin who
-- fixes a binding sees the count and titles re-derived on the next sweep
-- rather than in ninety days.
WITH rebound AS (
    SELECT (COALESCE(sqlc.narg('bgm_id')::integer, ac.bgm_id) IS DISTINCT FROM ac.bgm_id) AS yes
    FROM anime_cache ac
    WHERE ac.anilist_id = sqlc.arg('anilist_id')::integer
),
cleared_titles AS (
    DELETE FROM anime_episode_titles
    WHERE anime_id = sqlc.arg('anilist_id')::integer
      AND (SELECT yes FROM rebound)
)
UPDATE anime_cache
SET
    title_chinese = COALESCE(sqlc.narg('title_chinese'), title_chinese),
    bgm_id        = COALESCE(sqlc.narg('bgm_id')::integer, bgm_id),
    bangumi_score = COALESCE(sqlc.narg('bangumi_score')::numeric(4,2), bangumi_score),
    admin_flag    = 'manually-corrected',
    episodes_bgm              = CASE WHEN (SELECT yes FROM rebound)
                                     THEN NULL ELSE episodes_bgm END,
    episodes_bgm_at           = CASE WHEN (SELECT yes FROM rebound)
                                     THEN NULL ELSE episodes_bgm_at END,
    episodes_bgm_attempted_at = CASE WHEN (SELECT yes FROM rebound)
                                     THEN NULL ELSE episodes_bgm_attempted_at END,
    episodes_bgm_outcome      = CASE WHEN (SELECT yes FROM rebound)
                                     THEN NULL ELSE episodes_bgm_outcome END,
    episodes_bgm_reason       = CASE WHEN (SELECT yes FROM rebound)
                                     THEN NULL ELSE episodes_bgm_reason END,
    -- Same move as episodes_bgm_attempted_at above, for the sweep added in
    -- 0029.  cleared_titles has just deleted this row's episode titles, and
    -- the stamp beside them records an attempt made against the binding that
    -- was replaced -- so leaving it would tell the airing sweep this row was
    -- recently handled and keep it out of the candidate set for another 26
    -- hours, with the page showing no titles for the whole window.  Nulling it
    -- puts the row at the front of ListReleasingEpisodeTitleCandidates, which
    -- orders NULLS FIRST for exactly this case.
    episode_titles_at         = CASE WHEN (SELECT yes FROM rebound)
                                     THEN NULL ELSE episode_titles_at END,
    updated_at    = now()
WHERE anilist_id = sqlc.arg('anilist_id')::integer
RETURNING
    anilist_id,
    title_romaji,
    title_chinese,
    bgm_id,
    bangumi_score,
    admin_flag;

-- name: ListAnimeForReEnrichByVersion :many
-- Batch reader for re-enrich.  Returns the fields the queue payload
-- needs.  Filtering by version covers v0/v1/v2 — handler dispatches each
-- via the appropriate enqueue function.
--
-- For v0 the Express code accepts `bangumiVersion: 0` OR `$exists: false`.
-- In PG the column is `NOT NULL DEFAULT 0` (see 0001_init.up.sql:53) so
-- "missing" is impossible — a single = 0 covers it.
SELECT
    anilist_id,
    title_native,
    title_romaji,
    bgm_id,
    bangumi_version
FROM anime_cache
WHERE bangumi_version = $1;

-- name: ListEnrichedV2WithoutBgm :many
-- For re-enrich v=2:  rows that lack a bgm_id can't be V3-healed (V3
-- needs Bangumi subject id).  Express promotes them directly to v3 via
-- updateMany.  This query is the SELECT half; PromoteAnimeToV3 is the
-- UPDATE half.
SELECT anilist_id
FROM anime_cache
WHERE bangumi_version = 2
  AND bgm_id IS NULL;

-- name: ListEnrichedV2WithBgm :many
-- For re-enrich v=2:  rows that have a bgm_id can be V3-healed.
-- Returns the queue-payload fields directly.
SELECT
    anilist_id,
    bgm_id,
    title_chinese,
    bangumi_version
FROM anime_cache
WHERE bangumi_version = 2
  AND bgm_id IS NOT NULL;

-- name: PromoteAnimeToV3 :exec
-- Used by re-enrich v=2 path to mark no-bgm rows as fully enriched.
-- ANY($1::int[]) takes a Postgres int array — sqlc generates []int32.
UPDATE anime_cache
SET
    bangumi_version = 3,
    updated_at      = now()
WHERE anilist_id = ANY($1::integer[]);

-- name: ListHealCnCandidates :many
-- POST /api/admin/enrichment/heal-cn — Express filter:
--   bgmId: { $ne: null }
--   bangumiVersion: { $gte: 2, $lt: 3 }   // i.e. version = 2
--   $or: [{ titleChinese: null }, { titleChinese: { $exists: false } }]
--
-- Returns the queue payload shape (anilistId / bgmId / titleChinese /
-- bangumiVersion) so the handler can build V3 jobs directly.
SELECT
    anilist_id,
    bgm_id,
    title_chinese,
    bangumi_version
FROM anime_cache
WHERE bgm_id IS NOT NULL
  AND bangumi_version = 2
  AND title_chinese IS NULL;

-- name: DeleteAnimeCharactersForReset :exec
-- Wipe child tables when Reset clears a row.  Express puts characters /
-- episode_titles back to `undefined` in the document — Postgres mirrors
-- that with a DELETE inside the reset transaction.
DELETE FROM anime_characters WHERE anime_id = $1;

-- name: DeleteAnimeEpisodeTitlesForReset :exec
DELETE FROM anime_episode_titles WHERE anime_id = $1;

-- ==================== User management ====================

-- name: GetAdminUserSubFollowCounts :many
-- Batch fetch sub_count + follower_count for a slice of user ids.
-- Replaces the two Promise.all aggregate pipelines in listUsers.
-- Returns 0 for users with no rows on either side via LEFT JOIN.
SELECT
    u.id                                                                AS user_id,
    COALESCE(sub_counts.cnt, 0)::bigint                                  AS subscriptions,
    COALESCE(fol_counts.cnt, 0)::bigint                                  AS followers
FROM unnest($1::uuid[]) AS u(id)
LEFT JOIN (
    SELECT user_id, count(*) AS cnt
    FROM subscriptions
    GROUP BY user_id
) sub_counts ON sub_counts.user_id = u.id
LEFT JOIN (
    SELECT followee_id, count(*) AS cnt
    FROM follows
    GROUP BY followee_id
) fol_counts ON fol_counts.followee_id = u.id;

-- name: AdminCreateUser :one
-- POST /api/admin/users — create-by-admin path.  Caller bcrypts password
-- before passing it in.  RETURNING only the projection Express's
-- response uses ({ _id, username, email }) — handler maps to {id, ...}.
-- Unique violation (23505) bubbles up to handler → 409 with the field
-- name in the message.
INSERT INTO users (username, email, password)
VALUES ($1, $2, $3)
RETURNING id, username, email;

-- name: AdminUpdateUser :one
-- PATCH /api/admin/users/:userId — partial update of username/email.
-- COALESCE() lets the caller pass nil to skip a field; passing a value
-- overrides it.  Both empty means the handler returns 400 before we
-- reach this query.
UPDATE users
SET
    username   = COALESCE(sqlc.narg('username'), username),
    email      = COALESCE(sqlc.narg('email'), email),
    updated_at = now()
WHERE id = sqlc.arg('user_id')::uuid
RETURNING id, username, email, role, created_at;

-- name: AdminFindUserByUsernameOrEmailExcluding :one
-- Pre-update dup check.  Looks for an existing row with the same
-- username or email but a DIFFERENT id — i.e. would violate uniqueness
-- if the update went through.  Returns ErrNoRows when no conflict.
SELECT id, username, email
FROM users
WHERE (username = sqlc.narg('username') OR email = sqlc.narg('email'))
  AND id <> sqlc.arg('exclude_id')::uuid
LIMIT 1;

-- name: AdminFindUserByUsernameOrEmail :one
-- Pre-create dup check (no id exclusion since the row doesn't exist yet).
SELECT id, username, email
FROM users
WHERE username = sqlc.narg('username')
   OR email    = sqlc.narg('email')
LIMIT 1;

-- name: AdminDeleteUser :exec
-- DELETE /api/admin/users/:userId.  Subscriptions / follows / comments /
-- danmakus all ON DELETE CASCADE to users.id (see 0001_init.up.sql) so
-- a single DELETE removes everything Express did via Promise.all.
DELETE FROM users WHERE id = $1;

-- name: GetHantStats :one
-- zh-Hant coverage and drift — the numbers behind GET /api/admin/hant/stats.
--
-- Its own query rather than more columns on GetAdminStats, for the same
-- soft-fail reason GetDescriptionCnStats is separate: the admin page must
-- not lose users, anime and enrichment because one panel's columns are
-- missing on a container that rolled forward past migration 0022.
--
-- title_behind and desc_behind are the point of the whole endpoint.  Both
-- source columns keep growing as the enrichment workers fill them, and
-- nothing converts the new arrivals until this sweep runs, so these two
-- numbers are how a human decides whether to press the button.  They are
-- deliberately NOT the complement of title_hant / description_hant: a row
-- with no title_chinese at all is not behind, it is out of reach, and
-- counting it as work to do would leave the panel permanently non-zero.
--
-- serp_eligible reads title_hant_seo (migration 0022's generated column,
-- whitelist of wikipedia/anilist/manual) rather than re-deriving the
-- whitelist here.  Re-deriving it would let the dashboard disagree with
-- what the renderer actually puts in <title>.
--
-- Unfiltered aggregates over ~17.5k rows with no index, which migration
-- 0022 called out as expected: there is no predicate to accelerate and an
-- index on this table would cost more than the scan it saves.
SELECT
    count(*)::bigint                                                                        AS total,
    count(*) FILTER (WHERE title_hant IS NOT NULL)::bigint                                  AS title_hant,
    count(*) FILTER (WHERE description_hant IS NOT NULL)::bigint                            AS desc_hant,
    count(*) FILTER (WHERE title_hant_seo IS NOT NULL)::bigint                              AS serp_eligible,
    count(*) FILTER (WHERE title_chinese  IS NOT NULL AND title_hant       IS NULL)::bigint AS title_behind,
    count(*) FILTER (WHERE description_cn IS NOT NULL AND description_hant IS NULL)::bigint AS desc_behind
FROM anime_cache;

-- name: GetHantBackfillJobStatus :one
-- Whether a zh-Hant sweep is in flight, and when the last one finished.
--
-- Read out of river_job rather than a table of our own.  River already
-- decides what "in flight" means -- it is what the periodic scheduler and
-- the unique index both consult -- and a second source of truth would let
-- the admin page say "running" while river said "idle", or the reverse
-- after a crash that never got to update our column.
--
-- 'hant_backfill' MUST stay equal to HantBackfillArgs.Kind() in
-- internal/queue/args.go.  sqlc cannot read a Go const, so this is a
-- hand-kept mirror exactly like the '30 days' literals above.  Change one,
-- change both.
--
-- The state list is the non-terminal set, and MUST stay equal to
-- hantBackfillUniqueStates in internal/queue/args.go for the same reason:
-- the endpoint reports "running" for exactly the states in which a second
-- enqueue is collapsed into the first, so a row that says "running" is
-- also a row that explains why the button did nothing.  'cancelled' and
-- 'discarded' are terminal and deliberately absent -- a discarded sweep is
-- finished, badly, not in flight.
--
-- last_run_at is the last SUCCESS.  A sweep that exhausted its retries
-- also carries a finalized_at, and reporting that as the last run would
-- tell an operator the drift had been cleared when it had not.
SELECT
    -- The ::timestamptz cast is load-bearing, not decoration: without it
    -- sqlc cannot infer a type through the scalar subquery and generates
    -- `interface{}`, which scans into an untyped value the handler would
    -- have to type-assert at runtime.
    (SELECT max(finalized_at) FROM river_job
      WHERE kind = 'hant_backfill'
        AND state = 'completed')::timestamptz                       AS last_run_at,
    (SELECT EXISTS (SELECT 1 FROM river_job
                     WHERE kind = 'hant_backfill'
                       AND state IN ('available', 'pending', 'running',
                                     'retryable', 'scheduled')))::boolean AS running;

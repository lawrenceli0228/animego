-- The admin user table's per-page batches, one account's detail drawer, and
-- the admin's "sign this account out" action.
--
-- These describe ACCOUNTS, so they read `users` and `user_activity_daily`
-- directly rather than the activity_people / activity_days views (migration
-- 0054): a deleted account is not an account, and the views exist for
-- statistics about people over time.  The one exception is
-- instrumented_since below, which is a fact about the recorder rather than
-- about this account and is therefore read from the union like every other
-- seam on the admin page.
--
-- The page query itself (filters, sort, pagination, the segment counts) is
-- NOT here: its WHERE and ORDER BY are composed from a whitelist at request
-- time, which sqlc cannot express -- see internal/admin/list_users.go.
--
-- `today` is always a parameter, never derived from now() here.  The handler
-- computes the reporting day once per request (activity.Day, +08) and passes
-- the same value to the page query, the segment counts and the batches below,
-- so the strip, the segments and the response's `today` cannot disagree
-- across a midnight that falls between two statements.  Session liveness is
-- the exception and uses now(): expiry is an instant, not a reporting day.
--
-- Conventions follow admin.sql: counts are cast to ::bigint so sqlc emits
-- int64, and nullable aggregates are cast so sqlc can type them.

-- name: ListAdminUserRecentDays :many
-- The 30-day strip for one page of the user table: every recorded day in
-- [today-29, today], ascending per user.  One round-trip for the whole page.
-- An account with no row in the window simply contributes no rows; the
-- handler starts every account with an empty strip.
SELECT a.user_id, a.activity_date
FROM user_activity_daily AS a
WHERE a.user_id = ANY(sqlc.arg(user_ids)::uuid[])
  AND a.activity_date BETWEEN sqlc.arg(today)::date - 29 AND sqlc.arg(today)::date
ORDER BY a.user_id, a.activity_date;

-- name: ListAdminUserLastDevices :many
-- The most recently used LIVE session of each account on the page.  Expired
-- rows stay in user_sessions until the owner's next login prunes them, so
-- the expiry predicate is what keeps a device that can no longer refresh off
-- the "last device" column.  Ties on last_used_at break on id, the same order
-- the settings page lists devices in (ListUserSessions).
SELECT DISTINCT ON (s.user_id)
    s.user_id, s.user_agent, s.country, s.last_used_at
FROM user_sessions AS s
WHERE s.user_id = ANY(sqlc.arg(user_ids)::uuid[])
  AND s.expires_at > now()
ORDER BY s.user_id, s.last_used_at DESC, s.id;

-- name: GetAdminUserDetail :one
-- Every scalar the detail drawer shows, in one round-trip.  pgx.ErrNoRows
-- means the account does not exist (404).
--
-- Activity is all time: active_days counts every row (before
-- instrumented_since a row is a reconstructed interaction day, after it a
-- recorded visit -- the same caveat as the list column), recorded_days only
-- the rows the live recorder wrote (request_count > 0).
--
-- score_sum is returned instead of an average so the mean is computed in Go
-- from two NOT NULL integers: "no rated subscriptions" stays an explicit
-- null instead of depending on how a nullable float survives a cast.
--
-- Community counts skip soft-deleted rows where the table has deleted_at
-- (threads, replies, reviews); the other tables delete for real.
SELECT
    u.id,
    u.username,
    u.email,
    u.role,
    u.created_at,
    u.is_public,
    u.avatar_url,
    (SELECT count(*) FROM user_activity_daily AS a
      WHERE a.user_id = u.id)::bigint                                            AS active_days,
    (SELECT count(*) FROM user_activity_daily AS a
      WHERE a.user_id = u.id AND a.request_count > 0)::bigint                    AS recorded_days,
    (SELECT max(a.last_seen_at) FROM user_activity_daily AS a
      WHERE a.user_id = u.id)::timestamptz                                       AS last_seen_at,
    (SELECT COALESCE(sum(a.login_count), 0) FROM user_activity_daily AS a
      WHERE a.user_id = u.id)::bigint                                            AS logins,
    (SELECT COALESCE(sum(a.request_count), 0) FROM user_activity_daily AS a
      WHERE a.user_id = u.id)::bigint                                            AS requests,
    (SELECT count(*) FROM subscriptions AS s
      WHERE s.user_id = u.id)::bigint                                            AS subs_total,
    (SELECT count(*) FROM subscriptions AS s
      WHERE s.user_id = u.id AND s.status = 'watching')::bigint                  AS subs_watching,
    (SELECT count(*) FROM subscriptions AS s
      WHERE s.user_id = u.id AND s.status = 'completed')::bigint                 AS subs_completed,
    (SELECT count(*) FROM subscriptions AS s
      WHERE s.user_id = u.id AND s.status = 'plan_to_watch')::bigint             AS subs_plan_to_watch,
    (SELECT count(*) FROM subscriptions AS s
      WHERE s.user_id = u.id AND s.status = 'dropped')::bigint                   AS subs_dropped,
    (SELECT count(*) FROM subscriptions AS s
      WHERE s.user_id = u.id AND s.score IS NOT NULL)::bigint                    AS subs_rated,
    (SELECT COALESCE(sum(s.score), 0) FROM subscriptions AS s
      WHERE s.user_id = u.id)::bigint                                            AS subs_score_sum,
    (SELECT max(s.updated_at) FROM subscriptions AS s
      WHERE s.user_id = u.id)::timestamptz                                       AS subs_last_updated_at,
    (SELECT count(*) FROM episode_watches AS w
      WHERE w.user_id = u.id)::bigint                                            AS watches_total,
    (SELECT max(w.watched_at) FROM episode_watches AS w
      WHERE w.user_id = u.id)::timestamptz                                       AS last_watched_at,
    (SELECT count(*) FROM episode_comments AS c
      WHERE c.user_id = u.id)::bigint                                            AS comments,
    (SELECT count(*) FROM community_replies AS r
      WHERE r.user_id = u.id AND r.deleted_at IS NULL)::bigint                   AS replies,
    (SELECT count(*) FROM anime_threads AS t
      WHERE t.user_id = u.id AND t.deleted_at IS NULL)::bigint                   AS threads,
    (SELECT count(*) FROM anime_reviews AS v
      WHERE v.user_id = u.id AND v.deleted_at IS NULL)::bigint                   AS reviews,
    (SELECT count(*) FROM danmakus AS d
      WHERE d.user_id = u.id)::bigint                                            AS danmaku,
    (SELECT count(*) FROM follows AS f
      WHERE f.follower_id = u.id)::bigint                                        AS following,
    (SELECT count(*) FROM follows AS f
      WHERE f.followee_id = u.id)::bigint                                        AS followers,
    (SELECT count(*) FROM reports AS p
      WHERE p.reporter_id = u.id)::bigint                                        AS reports_filed,
    (SELECT count(*) FROM edit_submissions AS e
      WHERE e.user_id = u.id)::bigint                                            AS edit_submissions,
    (SELECT min(ad.activity_date) FROM activity_days AS ad
      WHERE ad.request_count > 0)::date                                          AS instrumented_since
FROM users AS u
WHERE u.id = sqlc.arg(id);

-- name: ListAdminUserActivityDays :many
-- The detail drawer's 90-day calendar: every recorded day of the account in
-- [today-89, today], ascending.  recorded = the live recorder wrote the row;
-- false means migration 0026 reconstructed it from other tables.
SELECT a.activity_date, (a.request_count > 0)::boolean AS recorded
FROM user_activity_daily AS a
WHERE a.user_id = sqlc.arg(user_id)
  AND a.activity_date BETWEEN sqlc.arg(today)::date - 89 AND sqlc.arg(today)::date
ORDER BY a.activity_date;

-- name: ListAdminUserRecentWatches :many
-- The account's newest episode marks with the title fields pickTitle()
-- reads.  Marks backfilled by migration 0024 share one watched_at, so the
-- tie-break (show, then episode, both descending) is what keeps the order
-- stable between two loads of the drawer.
SELECT
    w.anilist_id,
    c.title_chinese, c.title_romaji, c.title_english, c.title_native, c.title_hant,
    c.episodes,
    w.episode,
    w.watched_at
FROM episode_watches AS w
JOIN anime_cache AS c ON c.anilist_id = w.anilist_id
WHERE w.user_id = sqlc.arg(user_id)
ORDER BY w.watched_at DESC, w.anilist_id DESC, w.episode DESC
LIMIT sqlc.arg(row_limit)::int;

-- name: ListAdminUserRecentSubscriptions :many
-- The account's most recently updated subscriptions, same title fields.
SELECT
    s.anilist_id,
    c.title_chinese, c.title_romaji, c.title_english, c.title_native, c.title_hant,
    c.episodes,
    s.status,
    s.score,
    s.current_episode,
    s.updated_at
FROM subscriptions AS s
JOIN anime_cache AS c ON c.anilist_id = s.anilist_id
WHERE s.user_id = sqlc.arg(user_id)
ORDER BY s.updated_at DESC, s.anilist_id DESC
LIMIT sqlc.arg(row_limit)::int;

-- name: ListAdminUserLiveSessions :many
-- The account's live sessions, most recently used first: the settings
-- page's device list (ListUserSessions) as an admin sees it, plus expiry.
SELECT s.id, s.user_agent, s.country, s.created_at, s.last_used_at, s.expires_at
FROM user_sessions AS s
WHERE s.user_id = sqlc.arg(user_id)
  AND s.expires_at > now()
ORDER BY s.last_used_at DESC, s.id;

-- name: DeleteAllUserSessions :execrows
-- "Sign this account out everywhere", from the admin page.  Runs in
-- admin.UserStore.RevokeAllUserSessions' transaction after LockUserForRevoke
-- and ClearLegacyRefreshTokens -- the same order, for the same reason, as
-- auth.Store.RevokeOtherSessions, except that no session is kept: the admin
-- is not one of this account's devices.  Each device notices on its next
-- request, when jwtx's session check (UserSessionLive) no longer finds the
-- session its access token names.
DELETE FROM user_sessions
WHERE user_id = sqlc.arg(user_id);

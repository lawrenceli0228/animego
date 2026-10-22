-- user_sessions: one refresh session per device (migration 0052).
--
-- Every hash here is the sha256 hex digest of a refresh token
-- (auth.hashToken); no statement ever sees a raw token.  Every statement that
-- acts on a presented token is scoped by (id, user_id) from the token's own
-- claims AND by its hash, so a token can only ever touch the one row it was
-- issued for.

-- name: LockUserForNewSession :one
-- First half of opening a session (auth.Store.StartUserSession, with
-- CreateUserSession in the same transaction): holds the users row FOR SHARE,
-- and only while its password is still the hash the login just verified.
--
-- Without it a login racing a password change slips past the
-- users_password_ends_sessions trigger: the login reads the old hash and
-- checks it, the reset commits and its trigger deletes the user's sessions,
-- and only then does the login insert one — a session opened with a password
-- that no longer works, which nothing would ever end.  FOR SHARE conflicts
-- with the reset's row lock (FOR NO KEY UPDATE), so the two serialise: either
-- the reset waits and its trigger then sees, and deletes, this session, or
-- this waits, re-reads the row, finds the password changed and returns no
-- row (the login is refused).  FOR KEY SHARE would not conflict, and the
-- password predicate without a lock would serialise nothing.
SELECT id
FROM users
WHERE id = sqlc.arg(id)
  AND password = sqlc.arg(verified_password)
FOR SHARE;

-- name: CreateUserSession :exec
-- Login and register: a new row for the new device.  Never touches the
-- user's other rows — that is the whole fix.  Runs after
-- LockUserForNewSession, in its transaction.
INSERT INTO user_sessions (
    id, user_id, token_hash, token_jti, token_iat, token_exp, expires_at,
    user_agent, country, city
) VALUES (
    sqlc.arg(id), sqlc.arg(user_id), sqlc.arg(token_hash),
    sqlc.arg(token_jti), sqlc.arg(token_iat), sqlc.arg(token_exp), sqlc.arg(token_exp),
    sqlc.narg(user_agent), sqlc.narg(country), sqlc.narg(city)
);

-- name: PruneUserSessions :one
-- Run after CreateUserSession: drops the user's expired rows and keeps at
-- most keep_others live rows besides keep_id (the session just created),
-- most recently used first.  Returns how many rows the user has left.
--
-- keep_id is excluded explicitly rather than trusted to sort first: its
-- last_used_at is the insert's now(), and a session rotated in the same
-- instant on another device must not be able to push it out.
--
-- The remaining count is computed from the statement's snapshot, which still
-- sees the rows being deleted, hence the subtraction.
WITH pruned AS (
    DELETE FROM user_sessions
    WHERE user_sessions.user_id = sqlc.arg(user_id)
      AND user_sessions.id <> sqlc.arg(keep_id)
      AND (
          user_sessions.expires_at <= now()
          OR user_sessions.id NOT IN (
              SELECT kept.id
              FROM user_sessions AS kept
              WHERE kept.user_id = sqlc.arg(user_id)
                AND kept.id <> sqlc.arg(keep_id)
                AND kept.expires_at > now()
              ORDER BY kept.last_used_at DESC, kept.id
              LIMIT sqlc.arg(keep_others)::int
          )
      )
    RETURNING 1
)
SELECT (
    (SELECT count(*) FROM user_sessions AS s WHERE s.user_id = sqlc.arg(user_id))
    - (SELECT count(*) FROM pruned)
)::bigint AS remaining;

-- name: RotateUserSession :one
-- Refresh: compare-and-swap on the presented token's hash.  Moves the current
-- hash to previous_hash (honoured for the grace window, stamped by
-- rotated_at), writes the new token's hash and claims, and slides expiry.
--
-- `AND token_hash = presented_hash` is what makes a concurrent refresh, a
-- logout, a reuse revocation or a password change win against an in-flight
-- rotation: any of them changes or deletes the row first, and this matches
-- nothing (pgx.ErrNoRows) instead of writing a live token back.
--
-- RETURNING username and role saves the access-token signer a read.
--
-- The device columns (migration 0053) follow the latest request, so the
-- device list shows where a session was last used from; a request that does
-- not state one (no header, failed validation) keeps what the row has.
UPDATE user_sessions AS s
SET previous_hash = s.token_hash,
    token_hash    = sqlc.arg(new_hash),
    token_jti     = sqlc.arg(new_jti),
    token_iat     = sqlc.arg(new_iat),
    token_exp     = sqlc.arg(new_exp),
    expires_at    = sqlc.arg(new_exp),
    rotated_at    = now(),
    last_used_at  = now(),
    user_agent    = COALESCE(sqlc.narg(user_agent), s.user_agent),
    country       = COALESCE(sqlc.narg(country), s.country),
    city          = COALESCE(sqlc.narg(city), s.city)
FROM users AS u
WHERE s.id = sqlc.arg(id)
  AND s.user_id = sqlc.arg(user_id)
  AND s.token_hash = sqlc.arg(presented_hash)
  AND s.expires_at > now()
  AND u.id = s.user_id
RETURNING u.username, u.role;

-- name: GetUserSession :one
-- The re-read after a missed rotation: decides grace, reuse or gone.
--
-- within_grace is judged here, by the clock that stamped rotated_at, rather
-- than by the application's: a database on another host with a clock 30 s
-- behind would otherwise turn every lost race into a revoked session.
SELECT
    s.id, s.user_id, s.token_hash, s.previous_hash, s.rotated_at,
    s.token_jti, s.token_iat, s.token_exp,
    u.username, u.role,
    COALESCE(s.rotated_at > now() - sqlc.arg(grace_seconds)::int * interval '1 second', false)::boolean AS within_grace
FROM user_sessions AS s
JOIN users AS u ON u.id = s.user_id
WHERE s.id = sqlc.arg(id)
  AND s.user_id = sqlc.arg(user_id);

-- name: GetUserSessionByLegacyHash :one
-- The same re-read for a pre-0052 token (no sid): the session it was adopted
-- into, if any.  Same columns as GetUserSession, so the two rows convert.
SELECT
    s.id, s.user_id, s.token_hash, s.previous_hash, s.rotated_at,
    s.token_jti, s.token_iat, s.token_exp,
    u.username, u.role,
    COALESCE(s.rotated_at > now() - sqlc.arg(grace_seconds)::int * interval '1 second', false)::boolean AS within_grace
FROM user_sessions AS s
JOIN users AS u ON u.id = s.user_id
WHERE s.user_id = sqlc.arg(user_id)
  AND s.legacy_hash = sqlc.arg(legacy_hash);

-- name: InsertAdoptedSession :execrows
-- Adoption of a pre-0052 token, inside the transaction that cleared it from
-- the users row.  previous_hash = legacy_hash with rotated_at = now() puts
-- the old token in the grace slot, so a request racing the adoption with the
-- same old cookie is answered with the new token instead of a 401.
--
-- ON CONFLICT DO NOTHING: legacy_hash is UNIQUE, so a second adoption of the
-- same token inserts nothing (0 rows) and the caller rolls back and reads the
-- winner instead.
INSERT INTO user_sessions (
    id, user_id, token_hash, previous_hash, rotated_at,
    token_jti, token_iat, token_exp, expires_at, legacy_hash,
    user_agent, country, city
) VALUES (
    sqlc.arg(id), sqlc.arg(user_id), sqlc.arg(token_hash), sqlc.arg(legacy_hash), now(),
    sqlc.arg(token_jti), sqlc.arg(token_iat), sqlc.arg(token_exp), sqlc.arg(token_exp), sqlc.arg(legacy_hash),
    sqlc.narg(user_agent), sqlc.narg(country), sqlc.narg(city)
)
ON CONFLICT (legacy_hash) DO NOTHING;

-- name: DeleteUserSession :execrows
-- Reuse revocation: a token that is neither current nor inside the grace
-- window was presented for this session, so the session is ended.  Only this
-- one — the user's other devices are not involved.
DELETE FROM user_sessions
WHERE id = sqlc.arg(id)
  AND user_id = sqlc.arg(user_id);

-- name: DeleteUserSessionIfHeld :execrows
-- Logout: ends the session only when the presented token is still its current
-- or grace-slot token.  A signature alone outlives the token it signs, and an
-- unconditional delete would let a long-dead token log its former owner out.
DELETE FROM user_sessions
WHERE id = sqlc.arg(id)
  AND user_id = sqlc.arg(user_id)
  AND (token_hash = sqlc.arg(presented_hash) OR previous_hash = sqlc.arg(presented_hash));

-- name: DeleteUserSessionByLegacyHash :execrows
-- Logout with a pre-0052 cookie: also ends the session that cookie was
-- adopted into, so a logout racing the adoption cannot leave it alive.
DELETE FROM user_sessions
WHERE user_id = sqlc.arg(user_id)
  AND legacy_hash = sqlc.arg(legacy_hash);

-- name: ListUserSessions :many
-- The settings page's device list: the user's live sessions, most recently
-- used first.  Which one is this browser is decided by the caller from the
-- refresh cookie; the row does not know.
SELECT id, user_agent, country, city, created_at, last_used_at
FROM user_sessions
WHERE user_id = sqlc.arg(user_id)
  AND expires_at > now()
ORDER BY last_used_at DESC, id;

-- name: DeleteOtherUserSessions :execrows
-- "Sign out other devices": every session of the user but keep_id, the one
-- the request came from.  Runs with ClearLegacyRefreshTokens in one
-- transaction (auth.Store.RevokeOtherSessions).
DELETE FROM user_sessions
WHERE user_id = sqlc.arg(user_id)
  AND id <> sqlc.arg(keep_id);

-- name: GetHeldUserSession :one
-- Which session is this device: the sid in the request's refresh cookie,
-- only while that cookie is still the session's current or grace-slot
-- token.  A verified signature is not enough — a session revoked a minute
-- ago signs exactly as well — and the device list's endpoints act on the
-- answer (auth.Handlers.currentSession).
SELECT id
FROM user_sessions
WHERE id = sqlc.arg(id)
  AND user_id = sqlc.arg(user_id)
  AND (token_hash = sqlc.arg(presented_hash) OR previous_hash = sqlc.arg(presented_hash))
  AND expires_at > now();

-- name: LockHeldUserSession :one
-- GetHeldUserSession inside auth.Store.RevokeOtherSessions' transaction,
-- holding the row: the session being kept cannot be revoked or rotated away
-- between being checked and the others being deleted.
SELECT id
FROM user_sessions
WHERE id = sqlc.arg(id)
  AND user_id = sqlc.arg(user_id)
  AND (token_hash = sqlc.arg(presented_hash) OR previous_hash = sqlc.arg(presented_hash))
  AND expires_at > now()
FOR UPDATE;

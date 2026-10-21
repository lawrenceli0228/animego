-- user_sessions: one refresh session per device (migration 0052).
--
-- Every hash here is the sha256 hex digest of a refresh token
-- (auth.hashToken); no statement ever sees a raw token.  Every statement that
-- acts on a presented token is scoped by (id, user_id) from the token's own
-- claims AND by its hash, so a token can only ever touch the one row it was
-- issued for.

-- name: CreateUserSession :exec
-- Login and register: a new row for the new device.  Never touches the
-- user's other rows — that is the whole fix.
INSERT INTO user_sessions (
    id, user_id, token_hash, token_jti, token_iat, token_exp, expires_at
) VALUES (
    sqlc.arg(id), sqlc.arg(user_id), sqlc.arg(token_hash),
    sqlc.arg(token_jti), sqlc.arg(token_iat), sqlc.arg(token_exp), sqlc.arg(token_exp)
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
UPDATE user_sessions AS s
SET previous_hash = s.token_hash,
    token_hash    = sqlc.arg(new_hash),
    token_jti     = sqlc.arg(new_jti),
    token_iat     = sqlc.arg(new_iat),
    token_exp     = sqlc.arg(new_exp),
    expires_at    = sqlc.arg(new_exp),
    rotated_at    = now(),
    last_used_at  = now()
FROM users AS u
WHERE s.id = sqlc.arg(id)
  AND s.user_id = sqlc.arg(user_id)
  AND s.token_hash = sqlc.arg(presented_hash)
  AND s.expires_at > now()
  AND u.id = s.user_id
RETURNING u.username, u.role;

-- name: GetUserSession :one
-- The re-read after a missed rotation: decides grace, reuse or gone.
SELECT
    s.id, s.user_id, s.token_hash, s.previous_hash, s.rotated_at,
    s.token_jti, s.token_iat, s.token_exp,
    u.username, u.role
FROM user_sessions AS s
JOIN users AS u ON u.id = s.user_id
WHERE s.id = sqlc.arg(id)
  AND s.user_id = sqlc.arg(user_id);

-- name: GetUserSessionByLegacyHash :one
-- The same re-read for a pre-0052 token (no sid): the session it was adopted
-- into, if any.
SELECT
    s.id, s.user_id, s.token_hash, s.previous_hash, s.rotated_at,
    s.token_jti, s.token_iat, s.token_exp,
    u.username, u.role
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
    token_jti, token_iat, token_exp, expires_at, legacy_hash
) VALUES (
    sqlc.arg(id), sqlc.arg(user_id), sqlc.arg(token_hash), sqlc.arg(legacy_hash), now(),
    sqlc.arg(token_jti), sqlc.arg(token_iat), sqlc.arg(token_exp), sqlc.arg(token_exp), sqlc.arg(legacy_hash)
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

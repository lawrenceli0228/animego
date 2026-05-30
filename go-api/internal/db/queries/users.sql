-- Queries against the users table.  Auth flow (register / login / refresh
-- / logout / me) drives the read+write contract.  Password reset adds
-- token-keyed reads + multi-column update.
--
-- Conventions:
--   * uuid PK type-mapped to google/uuid.UUID via sqlc.yaml override.
--   * password column holds bcrypt hash; bcrypt comparison happens in
--     application code (bcrypt.CompareHashAndPassword).
--   * refresh_token / reset_password_token are nullable text — passed
--     as *string so sqlc can NULL them out via direct nil-pointer.

-- name: CreateUser :one
-- Inserts a new user.  Caller hashes password via bcrypt BEFORE calling
-- this.  Returns the full row so the handler can echo the public fields
-- in the response without a second read.
--
-- Unique constraint violations (username/email already taken) surface
-- as pgx.PgError code 23505 — handler catches + maps to 400 DUPLICATE.
INSERT INTO users (username, email, password)
VALUES ($1, $2, $3)
RETURNING
    id, username, email, password, role,
    refresh_token, reset_password_token, reset_password_expires,
    is_public, created_at, updated_at,
    previous_refresh_token, refresh_rotated_at;

-- name: GetUserByEmail :one
-- Login lookup.  Returns the row including the password hash so the
-- handler can bcrypt.CompareHashAndPassword.  pgx.ErrNoRows → 401
-- INVALID_CREDENTIALS (intentionally same message as wrong password
-- to avoid email enumeration).
SELECT
    id, username, email, password, role,
    refresh_token, reset_password_token, reset_password_expires,
    is_public, created_at, updated_at,
    previous_refresh_token, refresh_rotated_at
FROM users
WHERE email = $1;

-- name: GetUserByUsername :one
-- Uniqueness check during register (we also rely on the unique index,
-- but a pre-check gives a friendlier 400 vs a 500-looking pg error).
SELECT
    id, username, email, password, role,
    refresh_token, reset_password_token, reset_password_expires,
    is_public, created_at, updated_at,
    previous_refresh_token, refresh_rotated_at
FROM users
WHERE username = $1;

-- name: GetUserByID :one
-- /me + refresh + logout lookups by JWT-derived user id.  pgx.ErrNoRows
-- → 404 NOT_FOUND (user was deleted after token issued, rare).
-- Includes the grace-window columns (previous_refresh_token,
-- refresh_rotated_at) so the Refresh handler can tolerate the
-- immediately-previous token for 30 s after rotation.
SELECT
    id, username, email, password, role,
    refresh_token, reset_password_token, reset_password_expires,
    is_public, created_at, updated_at,
    previous_refresh_token, refresh_rotated_at
FROM users
WHERE id = $1;

-- name: UpdateUserRefreshToken :exec
-- Called after login (set new token) and logout (set NULL for all three
-- token columns — clears both current and grace-window state so a stolen
-- cookie is fully invalidated).
-- updated_at bumps to now() so callers can audit last-session activity.
UPDATE users
SET refresh_token          = $2,
    previous_refresh_token = NULL,
    refresh_rotated_at     = NULL,
    updated_at             = now()
WHERE id = $1;

-- name: RotateRefreshToken :exec
-- Atomically moves current refresh_token → previous_refresh_token and
-- writes the new token.  refresh_rotated_at is set to now() so the
-- Refresh handler can enforce the 30 s grace window.
-- Called on every NORMAL (non-grace) refresh rotation.
UPDATE users
SET previous_refresh_token = refresh_token,
    refresh_token          = $2,
    refresh_rotated_at     = now(),
    updated_at             = now()
WHERE id = $1;

-- name: SetResetPasswordToken :exec
-- forgot-password sets the token + 1h expiry.  Caller generates the
-- token via crypto/rand (32 random bytes hex-encoded — matches
-- Express's crypto.randomBytes(32).toString('hex')).
UPDATE users
SET reset_password_token   = $2,
    reset_password_expires = $3,
    updated_at             = now()
WHERE id = $1;

-- name: GetUserByResetToken :one
-- reset-password lookup by token AND not-expired.  Single query
-- replaces Express's MongoDB compound find — keeps the
-- token-validity check atomic with the read.
SELECT
    id, username, email, password, role,
    refresh_token, reset_password_token, reset_password_expires,
    is_public, created_at, updated_at,
    previous_refresh_token, refresh_rotated_at
FROM users
WHERE reset_password_token = $1
  AND reset_password_expires > now();

-- name: ResetUserPassword :exec
-- reset-password write: sets new bcrypt hash, clears both reset-token
-- columns, AND nulls refresh_token (invalidates all existing sessions).
-- Matches Express's multi-field $set in resetPassword.
UPDATE users
SET password               = $2,
    reset_password_token   = NULL,
    reset_password_expires = NULL,
    refresh_token          = NULL,
    updated_at             = now()
WHERE id = $1;

-- name: AdminSetUserPassword :exec
-- Admin-initiated password change (POST /api/admin/users/:id/password).
-- Sets a new bcrypt hash and nulls refresh_token so the target user's
-- existing sessions are invalidated (forces re-login with the new
-- password). Unlike ResetUserPassword it leaves the reset-token columns
-- alone — those belong to the self-serve forgot-password flow.
UPDATE users
SET password      = $2,
    refresh_token = NULL,
    updated_at    = now()
WHERE id = $1;

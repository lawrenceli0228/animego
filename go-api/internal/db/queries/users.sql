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
    previous_refresh_token, refresh_rotated_at,
    avatar_url, backdrop_anilist_id;

-- name: GetUserByEmail :one
-- Login lookup.  Returns the row including the password hash so the
-- handler can bcrypt.CompareHashAndPassword.  pgx.ErrNoRows → 401
-- INVALID_CREDENTIALS (intentionally same message as wrong password
-- to avoid email enumeration).
SELECT
    id, username, email, password, role,
    refresh_token, reset_password_token, reset_password_expires,
    is_public, created_at, updated_at,
    previous_refresh_token, refresh_rotated_at,
    avatar_url, backdrop_anilist_id
FROM users
WHERE email = $1;

-- name: GetUserByUsername :one
-- Uniqueness check during register (we also rely on the unique index,
-- but a pre-check gives a friendlier 400 vs a 500-looking pg error).
SELECT
    id, username, email, password, role,
    refresh_token, reset_password_token, reset_password_expires,
    is_public, created_at, updated_at,
    previous_refresh_token, refresh_rotated_at,
    avatar_url, backdrop_anilist_id
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
    previous_refresh_token, refresh_rotated_at,
    avatar_url, backdrop_anilist_id
FROM users
WHERE id = $1;

-- name: ClaimLegacyRefreshToken :one
-- Adoption of a refresh token issued before migration 0052 (no sid): the
-- first half of the transaction in auth.Store.AdoptLegacySession, which then
-- inserts the user_sessions row the token becomes.
--
-- Clears all three columns, not just refresh_token, for the reason the
-- kill-switch statements below do: the old credential is over the moment it
-- is adopted, and a grace slot left loaded here would be honoured by nothing
-- (Refresh no longer reads these columns) but would confuse the next reader.
--
-- `AND refresh_token = presented_token` is the whole authority for the
-- adoption: only the token the row still holds can be adopted, and only once.
-- A second refresh racing with the same cookie blocks on this row's lock,
-- re-checks the predicate after the first commits, matches nothing, and is
-- served from the adopted session's grace slot instead.
--
-- RETURNING username and role for the access token, as RotateUserSession does.
UPDATE users
SET refresh_token          = NULL,
    previous_refresh_token = NULL,
    refresh_rotated_at     = NULL,
    updated_at             = now()
WHERE id = sqlc.arg(id)
  AND refresh_token = sqlc.arg(presented_token)
RETURNING username, role;

-- name: LockUserForRevoke :one
-- First statement of auth.Store.RevokeOtherSessions: takes the users row so
-- the revoke and an adoption of a pre-0052 token serialise.  Without it an
-- adoption could commit between the revoke's delete and its legacy clear,
-- and the session it inserts would survive "sign out everywhere else".
-- NO KEY UPDATE, not UPDATE: it must conflict with the adoption's UPDATE of
-- the row but not with the KEY SHARE an INSERT into user_sessions takes on it.
SELECT id
FROM users
WHERE id = sqlc.arg(id)
FOR NO KEY UPDATE;

-- name: ClearLegacyRefreshTokens :execrows
-- "Sign out other devices" (auth.Store.RevokeOtherSessions), for the one
-- session per account that can still live on this row: a refresh token
-- issued before migration 0052 that no refresh has adopted yet.  It has no
-- user_sessions row, so the device list cannot show it and deleting the
-- user's other rows does not reach it; without this, a phone left in a
-- drawer since before the deploy would survive "sign out everywhere else".
--
-- Clears all three columns, like every statement that ends a session here.
-- The device asking cannot be holding this token: a sid in its own refresh
-- cookie is what identified it.  Remove with the columns.
UPDATE users
SET refresh_token          = NULL,
    previous_refresh_token = NULL,
    refresh_rotated_at     = NULL,
    updated_at             = now()
WHERE id = sqlc.arg(id)
  AND (refresh_token IS NOT NULL OR previous_refresh_token IS NOT NULL);

-- name: ClearRefreshTokenIfMatches :execrows
-- Since migration 0052 this ends only a pre-0052 session (a refresh token
-- with no sid, still held on the users row); sessions issued since live in
-- user_sessions and logout ends them with DeleteUserSessionIfHeld.  Remove it
-- with these three columns once every pre-0052 token has expired.
--
-- Logout's DB write: ends the session the CALLER actually holds, and only
-- that one.
--
-- ── WHY A PREDICATE AND NOT A PLAIN `WHERE id = $1` ──
-- Logout authenticates from the refresh cookie's SIGNATURE (logoutSubject).
-- A signature stays valid for the full 7-day refresh TTL, and nothing about
-- verifying it says the token is still the live one — a token this server
-- revoked minutes ago verifies exactly as well as the current one.
--
-- With an unconditional update that turns a DEAD credential back into a
-- weapon: someone holding a refresh token that was already invalidated (an
-- old browser profile on a shared machine, a stale backup, a captured
-- request) can POST /logout with it every few minutes and keep the rightful
-- owner from holding a session for a week.  They cannot read anything —
-- Refresh checks the token against the row, so a stale token still fails
-- there — but they can deny.  The predicate removes the primitive entirely:
-- a token that no longer matches the row now clears nothing.
--
-- previous_refresh_token is included in the match so the grace window keeps
-- working: a tab that refreshed a moment ago holds the token that just moved
-- into the grace slot, and it must still be able to log itself out.
--
-- This does NOT reinstate the bug that took logout off RequireAuth.  That one
-- was about a tab idle past the 15-minute ACCESS window; its refresh cookie is
-- still the row's current value, so the predicate matches and the row clears.
--
-- :execrows, and the caller does not treat 0 as an error.  Zero rows means
-- "that session was already over" — a double-click, a logout racing a login
-- on another device, a password reset that landed first.  The cookies are
-- cleared unconditionally before this runs either way.
UPDATE users
SET refresh_token          = NULL,
    previous_refresh_token = NULL,
    refresh_rotated_at     = NULL,
    updated_at             = now()
WHERE id = sqlc.arg(id)
  AND (refresh_token = sqlc.arg(presented_token)
       OR previous_refresh_token = sqlc.arg(presented_token));

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
    previous_refresh_token, refresh_rotated_at,
    avatar_url, backdrop_anilist_id
FROM users
WHERE reset_password_token = $1
  AND reset_password_expires > now();

-- name: ResetUserPassword :exec
-- reset-password write: sets the new bcrypt hash, clears both reset-token
-- columns, and clears ALL THREE refresh-session columns.
--
-- The per-device sessions in user_sessions end through the
-- users_password_ends_sessions trigger (migration 0052), in this statement's
-- transaction.  The columns below hold only pre-0052 sessions.
--
-- ── WHY previous_refresh_token AND refresh_rotated_at, NOT JUST refresh_token ──
-- The three columns are one piece of state, not one column plus two
-- bookkeeping fields.  The Refresh handler falls back to
-- previous_refresh_token for refreshGraceWindow (30 s) after a rotation, so
-- nulling only refresh_token left the row in a combination the read side did
-- not expect: previous matches the cookie, current is NULL.
--
-- What that produced is worth stating precisely, because the intuitive guess
-- is wrong.  It did NOT hand out a token.  The grace branch signs the access
-- token first, then dereferences *user.RefreshToken to re-set the cookie — so
-- a NULL current token panicked before anything reached the response writer.
-- The observable result was a 500 (caught by the Recoverer), for up to 30 s
-- after a password reset.  An availability bug, not a credential leak; do not
-- let a future reader "simplify" this on the theory that it was the latter.
--
-- The read side now nil-guards that dereference, which makes this clause
-- unreachable rather than unnecessary.  It stays for two reasons: the guard
-- is one `&&` away from deletion by someone who reads it as merely defensive,
-- and a write path whose safety depends on a nil check three files away is
-- not one a reviewer can check locally.  The rule is small enough to just
-- keep — ending a session clears all three columns.
--
-- ── SCOPE, STATED HONESTLY ──
-- This invalidates the REFRESH token.  It does NOT invalidate access tokens:
-- those are stateless JWTs, so an already-issued one keeps working until it
-- expires on its own (accessTTL, JWT_EXPIRES_IN, 15m by default).  There is
-- no server-side access-token revocation in this codebase — no token version
-- column, no denylist.  Any comment or UI copy promising that a password
-- change "ends all sessions" is overpromising by up to 15 minutes.
UPDATE users
SET password               = $2,
    reset_password_token   = NULL,
    reset_password_expires = NULL,
    refresh_token          = NULL,
    previous_refresh_token = NULL,
    refresh_rotated_at     = NULL,
    updated_at             = now()
WHERE id = $1;

-- name: AdminSetUserPassword :exec
-- Admin-initiated password change (POST /api/admin/users/:id/password).
-- Sets a new bcrypt hash and clears all three refresh-session columns; the
-- password trigger (migration 0052) ends every user_sessions row.  Together
-- they stop every refresh token the target user holds — see ResetUserPassword for
-- why all three go together rather than refresh_token alone.  Unlike
-- ResetUserPassword it leaves the reset-token columns alone; those belong to
-- the self-serve forgot-password flow.
--
-- Scope is the same and worth repeating here, because this is the statement
-- an operator reaches for when they believe an account is compromised: it
-- invalidates the REFRESH token, not access tokens.  A stateless JWT already
-- in the attacker's hands stays valid until accessTTL runs out (15m default).
-- Locking someone out immediately takes more than this statement.
UPDATE users
SET password               = $2,
    refresh_token          = NULL,
    previous_refresh_token = NULL,
    refresh_rotated_at     = NULL,
    updated_at             = now()
WHERE id = $1;

-- name: UpdateUsername :one
-- PATCH /api/auth/me — self-serve rename. Unique violation (23505) on the
-- username index → handler maps to 400 DUPLICATE. Returns the full row so
-- the handler echoes the updated SafeUser.
UPDATE users
SET username   = $2,
    updated_at = now()
WHERE id = $1
RETURNING
    id, username, email, password, role,
    refresh_token, reset_password_token, reset_password_expires,
    is_public, created_at, updated_at,
    previous_refresh_token, refresh_rotated_at,
    avatar_url, backdrop_anilist_id;

-- name: SetUserAvatar :exec
-- PATCH /api/auth/me — set ($2 = data URL) or clear ($2 = NULL) the pass photo.
UPDATE users
SET avatar_url = $2,
    updated_at = now()
WHERE id = $1;

-- name: SetUserBackdrop :exec
-- PATCH /api/auth/me — set ($2 = anilist id) or clear ($2 = NULL) the backdrop.
UPDATE users
SET backdrop_anilist_id = $2,
    updated_at          = now()
WHERE id = $1;

-- name: SetUserPublic :exec
-- PATCH /api/auth/me — control whether another user may see the account's
-- watching list and whether this user's activity is eligible for social feeds.
-- The profile header remains resolvable so existing profile links do not turn
-- into misleading 404s; the social handler redacts the watching list instead.
UPDATE users
SET is_public = $2,
    updated_at = now()
WHERE id = $1;

-- name: UpdateUserPassword :exec
-- Dormant: there is no self-serve change-password endpoint (password
-- changes go through the email reset flow). Kept so the column write is
-- available if a verified flow ever needs it.
--
-- It clears the refresh-session columns anyway, even with no caller, because
-- the shape a dormant query ships in is the shape whoever wires it up will
-- trust.  Left as a bare password write, the first self-serve
-- change-password endpoint would silently be the one password path that
-- revokes nothing — the reader would reasonably assume a statement named
-- UpdateUserPassword behaves like its two siblings above.  Being wrong in
-- the same direction as the others is the cheaper failure.
--
-- NOTE FOR WHOEVER WIRES THIS UP: the password trigger (migration 0052) ends
-- every user_sessions row, the acting device's included, since that is the
-- session the caller is holding.  A
-- change-password handler must issue a fresh token pair and re-set the
-- cookies before responding, or the user changes their password and is
-- immediately bounced to the login screen.  Access tokens are unaffected
-- either way (stateless JWT, valid until accessTTL expires).
UPDATE users
SET password               = $2,
    refresh_token          = NULL,
    previous_refresh_token = NULL,
    refresh_rotated_at     = NULL,
    updated_at             = now()
WHERE id = $1;

-- name: GetAnimeImages :one
-- banner + cover for one anime, to theme the navbar avatar mini-card from
-- the user's chosen backdrop (resolves users.backdrop_anilist_id → images).
-- pgx.ErrNoRows when the anime isn't cached → handler leaves the fields nil.
SELECT banner_image_url, cover_image_url
FROM anime_cache
WHERE anilist_id = $1;

-- 0052: one refresh session per device.
--
-- The refresh credential used to live on the users row: refresh_token,
-- previous_refresh_token and refresh_rotated_at, one set per ACCOUNT.  A login
-- overwrote it, so signing in on a phone ended the session on the laptop the
-- next time the laptop's 15-minute access token ran out and it tried to
-- refresh.  Two browsers, or a normal and a private window, did the same to
-- each other.
--
-- user_sessions holds one row per login.  The refresh JWT carries the row's
-- id as `sid`; rotation, the 30 s grace window and logout each touch only the
-- row the presented token belongs to.
--
-- ── NO TOKEN IS STORED ──
-- token_hash, previous_hash and legacy_hash are sha256 hex digests of refresh
-- tokens, never the tokens.  A read of this table yields nothing that can be
-- presented as a cookie.  The grace window still needs to hand the client the
-- CURRENT token, so the claims that make it up are kept instead (token_jti,
-- token_iat, token_exp; sid and user id are the row's own columns) and the
-- token is re-signed from them; the handler sends it only if its digest
-- equals token_hash.  The CHECKs make "a raw token was written here" a
-- constraint violation rather than a code-review catch.
--
-- ── THE users COLUMNS DURING THE TRANSITION ──
-- A browser signed in before this deploy holds a refresh token with no sid,
-- matching users.refresh_token.  Its first refresh clears those columns and
-- inserts a session here in one transaction ("adoption"), so nobody is signed
-- out by the deploy.  legacy_hash records which old token a session was
-- adopted from: UNIQUE so one old token yields at most one session, and kept
-- so that replaying the old token later is recognised as reuse instead of
-- being adopted a second time.  The users columns and this column go away
-- together once every pre-deploy token has expired.
--
-- ── PASSWORD CHANGES END EVERY SESSION ──
-- The trigger, not the three statements that change a password, deletes the
-- user's sessions, so a fourth password write added later cannot forget to.
-- It fires in the writing transaction: a password change and the end of the
-- sessions commit together or not at all.  Access tokens are stateless and
-- unaffected; they run out on their own within JWT_EXPIRES_IN (15m).
--
-- ── ROLLING BACK ──
-- Redeploy the previous build and leave this migration applied.  The old
-- build ignores the table, and the trigger only ever deletes from it.  Running
-- the down migration throws away every session, so a later forward deploy
-- would sign everyone out a second time.

CREATE TABLE user_sessions (
    id            uuid PRIMARY KEY,
    user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash    text NOT NULL,
    previous_hash text,
    rotated_at    timestamptz,
    token_jti     uuid NOT NULL,
    token_iat     timestamptz NOT NULL,
    token_exp     timestamptz NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_used_at  timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL,
    legacy_hash   text UNIQUE,
    CONSTRAINT user_sessions_token_hash_chk    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT user_sessions_previous_hash_chk CHECK (previous_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT user_sessions_legacy_hash_chk   CHECK (legacy_hash ~ '^[0-9a-f]{64}$'),
    -- The grace window is judged against rotated_at; a previous hash without
    -- a clock would be honoured by nothing, a clock without one is meaningless.
    CONSTRAINT user_sessions_grace_pair_chk CHECK ((previous_hash IS NULL) = (rotated_at IS NULL))
);

CREATE INDEX user_sessions_user_id_idx ON user_sessions (user_id);

CREATE FUNCTION user_sessions_end_on_password_change()
  RETURNS TRIGGER
  AS $$
BEGIN
  DELETE FROM user_sessions WHERE user_id = NEW.id;
  RETURN NULL;
END;
$$
LANGUAGE plpgsql;

CREATE TRIGGER users_password_ends_sessions
  AFTER UPDATE OF password ON users
  FOR EACH ROW
  WHEN (OLD.password IS DISTINCT FROM NEW.password)
  EXECUTE FUNCTION user_sessions_end_on_password_change();

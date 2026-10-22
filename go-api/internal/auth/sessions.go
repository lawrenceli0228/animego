package auth

// sessions.go — one refresh session per device (migration 0052).
//
// A refresh token used to be stored on the users row, one per account, and
// a login overwrote it: signing in on a phone signed the laptop out the next
// time its 15-minute access token ran out.  Each login now opens its own
// user_sessions row, the refresh JWT names that row (`sid`), and refresh and
// logout only ever touch the row the presented token belongs to.
//
// Refresh, end to end:
//
//	POST /api/auth/refresh
//	  │ no cookie ─────────────────────────────────────────────► 401 NO_TOKEN
//	  │ bad signature ─────────────────────────────────────────► 401 INVALID_TOKEN
//	  ├─ sid set: refreshSession
//	  │    CAS on (sid, uid, token_hash = sha256(cookie))
//	  │      hit ──► rotate (prev ← cur, new hash/jti/iat/exp) ─► 200 + cookies   rotated
//	  │      miss ─► read row (sid, uid)
//	  │               none ────────────────────────────────────► 401              not_found
//	  │               └─► resolveMiss
//	  └─ no sid (minted before 0052): refreshLegacy
//	       txn: clear users.refresh_token where it = cookie; insert session
//	         hit ──► 200 + cookies carrying the new sid ─────────────────────── legacy_adopted
//	         miss ─► read row by legacy_hash
//	                  none ────────────────────────────────────► 401              legacy_unmatched
//	                  └─► resolveMiss
//
//	resolveMiss:
//	  cookie is previous_hash and rotated < 30 s (by the database's clock)
//	     re-sign current from stored claims; sha256 == token_hash?
//	        yes ► 200 + cookies ───────────────────────────── grace / legacy_grace
//	        no  ► 200, access token only (warn) ──────────────────── grace_mismatch
//	  cookie is token_hash (the CAS refused it: expired) ─────► 401   not_found
//	  otherwise: an old token replayed ─► delete this row ────► 401   reuse_revoked
//
// Every refresh, login and logout writes one `auth: session` log line with
// event, outcome, userId and sid, so "are people still being signed out, and
// why" is a count over the logs rather than a guess.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
	"github.com/lawrenceli0228/animego/go-api/internal/jwtx"
)

// maxSessionsPerUser bounds one account's rows.  A login beyond it drops the
// least recently used session; twenty devices is more than anyone signs in
// on, and few enough that an account cannot grow the table without bound.
const maxSessionsPerUser = 20

// The `event` field of an `auth: session` line.
const (
	eventLogin    = "login"
	eventRegister = "register"
	eventRefresh  = "refresh"
	eventLogout   = "logout"
)

// refreshGraceSeconds is refreshGraceWindow as the database judges it
// (GetUserSession's within_grace).
const refreshGraceSeconds = int32(refreshGraceWindow / time.Second)

// ErrPasswordChanged is StartUserSession's answer when the user's password
// changed between the login checking it and the session being written.  The
// login is refused as if the password were wrong, which by then it is.
var ErrPasswordChanged = errors.New("auth: password changed while signing in")

// The `outcome` field of an `auth: session` line.
const (
	outcomeStarted         = "started" // login / register opened a session
	outcomePasswordChanged = "password_changed"
	outcomeEnded           = "ended" // logout; `deleted` says whether a row went
	outcomeRotated         = "rotated"
	outcomeGrace           = "grace"
	outcomeGraceMismatch   = "grace_mismatch"
	outcomeReuseRevoked    = "reuse_revoked"
	outcomeNotFound        = "not_found"
	outcomeLegacyAdopted   = "legacy_adopted"
	outcomeLegacyGrace     = "legacy_grace"
	outcomeLegacyUnmatched = "legacy_unmatched"
	outcomeError           = "error"
)

// hashToken is the only form in which a refresh token reaches the database.
func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func timestamptz(t time.Time) pgtype.Timestamptz {
	return pgtype.Timestamptz{Time: t, Valid: true}
}

// Store is the production AuthDB: the generated queries, plus the one
// operation that needs a transaction.
type Store struct {
	*dbgen.Queries
	pool *pgxpool.Pool
}

// NewStore wraps a pool for NewHandlers.
func NewStore(pool *pgxpool.Pool) *Store {
	return &Store{Queries: dbgen.New(pool), pool: pool}
}

// StartUserSession writes a login's session while holding the users row
// FOR SHARE, and only if the password is still verifiedPassword — the hash
// the login just checked (LockUserForNewSession explains the race this
// closes).  ErrPasswordChanged when it no longer is; nothing is written.
func (s *Store) StartUserSession(ctx context.Context, verifiedPassword string, arg dbgen.CreateUserSessionParams) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("auth: begin session: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	q := dbgen.New(tx)
	if _, err := q.LockUserForNewSession(ctx, arg.UserID, verifiedPassword); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrPasswordChanged
		}
		return fmt.Errorf("auth: lock user for session: %w", err)
	}
	if err := q.CreateUserSession(ctx, arg); err != nil {
		return fmt.Errorf("auth: insert session: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("auth: commit session: %w", err)
	}
	return nil
}

// ErrSessionGone is RevokeOtherSessions' answer when the session the
// request came from is no longer live — revoked, rotated past, or expired —
// by the time the transaction holds it.  Nothing was deleted.
var ErrSessionGone = errors.New("auth: the request's session is no longer live")

// RevokeOtherSessions ends every session of the user except keepID — the
// one the request came from, still holding presentedHash — and, in the same
// transaction, a pre-0052 refresh token still held on the users row
// (ClearLegacyRefreshTokens says why that one has to be named separately).
// Returns how many sessions ended.
//
// Order matters.  The users row is locked first, so an adoption of a
// pre-0052 token either commits before (its session is then one of the
// "others") or waits and finds its token cleared.  The kept session is
// locked and re-checked next: a session revoked a moment ago must not be the
// one that survives while every live one goes.
func (s *Store) RevokeOtherSessions(ctx context.Context, userID, keepID uuid.UUID, presentedHash string) (int64, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("auth: begin revoke: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	q := dbgen.New(tx)
	if _, err := q.LockUserForRevoke(ctx, userID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, ErrSessionGone
		}
		return 0, fmt.Errorf("auth: lock user for revoke: %w", err)
	}
	if _, err := q.LockHeldUserSession(ctx, keepID, userID, presentedHash); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, ErrSessionGone
		}
		return 0, fmt.Errorf("auth: lock kept session: %w", err)
	}
	legacy, err := q.ClearLegacyRefreshTokens(ctx, userID)
	if err != nil {
		return 0, fmt.Errorf("auth: clear legacy session: %w", err)
	}
	n, err := q.DeleteOtherUserSessions(ctx, userID, keepID)
	if err != nil {
		return 0, fmt.Errorf("auth: delete other sessions: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("auth: commit revoke: %w", err)
	}
	return n + legacy, nil
}

// AdoptLegacySessionParams is a pre-0052 refresh token to adopt and the
// session it becomes.
type AdoptLegacySessionParams struct {
	UserID         uuid.UUID
	PresentedToken string
	Session        dbgen.InsertAdoptedSessionParams
}

// AdoptLegacySession moves a pre-0052 refresh token off the users row and
// into a user_sessions row, in one transaction.  pgx.ErrNoRows means there
// was nothing to adopt: the users row no longer holds this token (adopted
// already, logged out, password changed, or a newer login on the old build),
// or another request adopted it first.  Either way nothing was written.
func (s *Store) AdoptLegacySession(ctx context.Context, p AdoptLegacySessionParams) (dbgen.ClaimLegacyRefreshTokenRow, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return dbgen.ClaimLegacyRefreshTokenRow{}, fmt.Errorf("auth: begin adoption: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	q := dbgen.New(tx)
	row, err := q.ClaimLegacyRefreshToken(ctx, p.UserID, &p.PresentedToken)
	if err != nil {
		return dbgen.ClaimLegacyRefreshTokenRow{}, fmt.Errorf("auth: claim legacy token: %w", err)
	}
	n, err := q.InsertAdoptedSession(ctx, p.Session)
	if err != nil {
		return dbgen.ClaimLegacyRefreshTokenRow{}, fmt.Errorf("auth: insert adopted session: %w", err)
	}
	if n == 0 {
		// legacy_hash conflict: adopted already.  Roll back the claim too.
		return dbgen.ClaimLegacyRefreshTokenRow{}, pgx.ErrNoRows
	}
	if err := tx.Commit(ctx); err != nil {
		return dbgen.ClaimLegacyRefreshTokenRow{}, fmt.Errorf("auth: commit adoption: %w", err)
	}
	return row, nil
}

// startSession opens a session for a device that has just proved the
// password (Login, Register): a new row, and nothing else of the user's is
// touched beyond pruning past maxSessionsPerUser.  Returns the access and
// refresh tokens to set, or ErrPasswordChanged if user.Password — the hash
// the caller verified — is no longer the account's.
func (h *Handlers) startSession(ctx context.Context, user dbgen.User, event string, info clientInfo) (string, string, error) {
	sid := uuid.New()
	issued, err := h.signer.SignRefresh(user.ID, sid)
	if err != nil {
		return "", "", fmt.Errorf("sign refresh: %w", err)
	}
	access, err := h.signer.SignAccess(user.ID, user.Username, user.Role)
	if err != nil {
		return "", "", fmt.Errorf("sign access: %w", err)
	}

	err = h.db.StartUserSession(ctx, user.Password, dbgen.CreateUserSessionParams{
		ID:        sid,
		UserID:    user.ID,
		TokenHash: hashToken(issued.Token),
		TokenJti:  issued.JTI,
		TokenIat:  timestamptz(issued.IssuedAt),
		TokenExp:  timestamptz(issued.ExpiresAt),
		UserAgent: info.UserAgent,
		Country:   info.Country,
		City:      info.City,
	})
	switch {
	case errors.Is(err, ErrPasswordChanged):
		h.logSession(ctx, event, outcomePasswordChanged, user.ID, sid)
		return "", "", err
	case err != nil:
		h.logSession(ctx, event, outcomeError, user.ID, sid, "err", err)
		return "", "", fmt.Errorf("persist session: %w", err)
	}

	// A failed prune does not fail the login: the user is in, and the surplus
	// waits for their next login.
	remaining, err := h.db.PruneUserSessions(ctx, user.ID, sid, maxSessionsPerUser-1)
	if err != nil {
		h.log().WarnContext(ctx, "auth: session prune failed", "userId", user.ID, "sid", sid, "err", err)
		h.logSession(ctx, event, outcomeStarted, user.ID, sid)
		return access, issued.Token, nil
	}
	h.logSession(ctx, event, outcomeStarted, user.ID, sid, "sessions_after_prune", remaining)
	return access, issued.Token, nil
}

// refreshSession rotates a token that names its session.
func (h *Handlers) refreshSession(ctx context.Context, w http.ResponseWriter, claims *jwtx.RefreshClaims, cookieToken string, info clientInfo) {
	uid, sid := claims.UserID, claims.SessionID
	presented := hashToken(cookieToken)

	next, err := h.signer.SignRefresh(uid, sid)
	if err != nil {
		h.failRefresh(ctx, w, sid, uid, err, "sign token failed")
		return
	}
	row, err := h.db.RotateUserSession(ctx, dbgen.RotateUserSessionParams{
		NewHash:       hashToken(next.Token),
		NewJti:        next.JTI,
		NewIat:        timestamptz(next.IssuedAt),
		NewExp:        timestamptz(next.ExpiresAt),
		ID:            sid,
		UserID:        uid,
		PresentedHash: presented,
		UserAgent:     info.UserAgent,
		Country:       info.Country,
		City:          info.City,
	})
	switch {
	case err == nil:
		h.answerRefresh(ctx, w, uid, sid, row.Username, row.Role, next.Token, outcomeRotated)
		return
	case !errors.Is(err, pgx.ErrNoRows):
		h.failRefresh(ctx, w, sid, uid, err, "persist session failed")
		return
	}

	// The CAS matched nothing.  Re-read once: a concurrent refresh, a logout,
	// a password change or expiry each look the same from here.
	sess, err := h.db.GetUserSession(ctx, refreshGraceSeconds, sid, uid)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		h.logSession(ctx, eventRefresh, outcomeNotFound, uid, sid)
		httpx.Fail(w, httpx.NewError(http.StatusUnauthorized, codeInvalidToken, msgInvalidToken))
	case err != nil:
		h.failRefresh(ctx, w, sid, uid, err, "session lookup failed")
	default:
		h.resolveMiss(ctx, w, sess, presented, false)
	}
}

// refreshLegacy answers a token minted before 0052 (no sid) by adopting it
// into a session, so the deploy signs nobody out.
func (h *Handlers) refreshLegacy(ctx context.Context, w http.ResponseWriter, uid uuid.UUID, cookieToken string, info clientInfo) {
	legacyHash := hashToken(cookieToken)
	sid := uuid.New()

	next, err := h.signer.SignRefresh(uid, sid)
	if err != nil {
		h.failRefresh(ctx, w, sid, uid, err, "sign token failed")
		return
	}
	row, err := h.db.AdoptLegacySession(ctx, AdoptLegacySessionParams{
		UserID:         uid,
		PresentedToken: cookieToken,
		Session: dbgen.InsertAdoptedSessionParams{
			ID:         sid,
			UserID:     uid,
			TokenHash:  hashToken(next.Token),
			LegacyHash: &legacyHash,
			TokenJti:   next.JTI,
			TokenIat:   timestamptz(next.IssuedAt),
			TokenExp:   timestamptz(next.ExpiresAt),
			UserAgent:  info.UserAgent,
			Country:    info.Country,
			City:       info.City,
		},
	})
	switch {
	case err == nil:
		h.answerRefresh(ctx, w, uid, sid, row.Username, row.Role, next.Token, outcomeLegacyAdopted)
		return
	case !errors.Is(err, pgx.ErrNoRows):
		h.failRefresh(ctx, w, sid, uid, err, "adopt session failed")
		return
	}

	adopted, err := h.db.GetUserSessionByLegacyHash(ctx, refreshGraceSeconds, uid, &legacyHash)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		h.logSession(ctx, eventRefresh, outcomeLegacyUnmatched, uid, uuid.Nil)
		httpx.Fail(w, httpx.NewError(http.StatusUnauthorized, codeInvalidToken, msgInvalidToken))
	case err != nil:
		h.failRefresh(ctx, w, uuid.Nil, uid, err, "session lookup failed")
	default:
		h.resolveMiss(ctx, w, dbgen.GetUserSessionRow(adopted), legacyHash, true)
	}
}

// resolveMiss answers a refresh whose token is not the session's current
// one: the grace window, an expired session, or a replayed old token.
func (h *Handlers) resolveMiss(ctx context.Context, w http.ResponseWriter, sess dbgen.GetUserSessionRow, presented string, legacy bool) {
	if inGraceWindow(sess, presented) {
		h.serveGrace(ctx, w, sess, legacy)
		return
	}
	if sess.TokenHash == presented {
		// The current token, refused by the CAS's expiry check.
		h.logSession(ctx, eventRefresh, outcomeNotFound, sess.UserID, sess.ID)
		httpx.Fail(w, httpx.NewError(http.StatusUnauthorized, codeInvalidToken, msgInvalidToken))
		return
	}

	// A token this session has already moved past, presented after the grace
	// window.  Either the device lost a response for over 30 s, or someone else
	// holds a copy; the two cannot be told apart, so the session ends.  Only
	// this one: the user's other devices are untouched.
	if _, err := h.db.DeleteUserSession(ctx, sess.ID, sess.UserID); err != nil {
		h.logSession(ctx, eventRefresh, outcomeError, sess.UserID, sess.ID, "err", err)
	}
	h.logSession(ctx, eventRefresh, outcomeReuseRevoked, sess.UserID, sess.ID, "legacy", legacy)
	httpx.Fail(w, httpx.NewError(http.StatusUnauthorized, codeInvalidToken, msgInvalidToken))
}

// inGraceWindow: the presented token was this session's current one until a
// rotation less than refreshGraceWindow ago — the losing side of two
// near-simultaneous refreshes (RSC prefetch + navigation).  The "less than"
// is the database's verdict (WithinGrace), measured by the clock that
// stamped rotated_at.
func inGraceWindow(sess dbgen.GetUserSessionRow, presented string) bool {
	return sess.PreviousHash != nil &&
		*sess.PreviousHash == presented &&
		sess.WithinGrace
}

// serveGrace issues an access token and hands the client the session's
// CURRENT refresh token, rebuilt from the stored claims, without rotating
// again (that would strand the request that won).  The rebuilt token is sent
// only if it hashes to token_hash; otherwise the client gets the access token
// alone and keeps the cookie it has.
func (h *Handlers) serveGrace(ctx context.Context, w http.ResponseWriter, sess dbgen.GetUserSessionRow, legacy bool) {
	outcome := outcomeGrace
	if legacy {
		outcome = outcomeLegacyGrace
	}
	current, err := h.signer.ResignRefresh(sess.UserID, sess.ID, sess.TokenJti, sess.TokenIat.Time, sess.TokenExp.Time)
	if err != nil {
		h.failRefresh(ctx, w, sess.ID, sess.UserID, err, "sign token failed")
		return
	}
	if hashToken(current) != sess.TokenHash {
		current, outcome = "", outcomeGraceMismatch
	}
	h.answerRefresh(ctx, w, sess.UserID, sess.ID, sess.Username, sess.Role, current, outcome)
}

// answerRefresh signs the access token and writes the 200.  An empty
// refreshToken leaves the client's refresh cookie as it is.
func (h *Handlers) answerRefresh(ctx context.Context, w http.ResponseWriter, uid, sid uuid.UUID, username string, role *string, refreshToken, outcome string) {
	access, err := h.signer.SignAccess(uid, username, role)
	if err != nil {
		h.failRefresh(ctx, w, sid, uid, err, "sign token failed")
		return
	}
	if refreshToken != "" {
		SetRefreshCookie(w, refreshToken, h.refreshTTL, h.isProd)
	}
	SetSessionCookie(w, access, h.accessTTL, h.isProd)
	SetAuthHintCookie(w, h.refreshTTL, h.isProd)
	h.logSession(ctx, eventRefresh, outcome, uid, sid)
	httpx.Data(w, http.StatusOK, RefreshData{AccessToken: access})
}

func (h *Handlers) failRefresh(ctx context.Context, w http.ResponseWriter, sid, uid uuid.UUID, err error, msg string) {
	h.logSession(ctx, eventRefresh, outcomeError, uid, sid, "err", err)
	httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, codeServerError, msg))
}

// endSession is logout's database half: it ends the session the presented
// token belongs to, if that token is still its current or grace-slot token.
// Failures are logged, never returned — the cookies are already cleared.
func (h *Handlers) endSession(ctx context.Context, claims *jwtx.RefreshClaims, token string) {
	uid, sid := claims.UserID, claims.SessionID
	presented := hashToken(token)

	if sid != uuid.Nil {
		n, err := h.db.DeleteUserSessionIfHeld(ctx, sid, uid, presented)
		if err != nil {
			h.logSession(ctx, eventLogout, outcomeError, uid, sid, "err", err)
			return
		}
		h.logSession(ctx, eventLogout, outcomeEnded, uid, sid, "deleted", n)
		return
	}

	// A pre-0052 cookie: end it on the users row, and end the session it may
	// have been adopted into by a refresh racing this logout.
	cleared, err := h.db.ClearRefreshTokenIfMatches(ctx, uid, &token)
	if err != nil {
		h.logSession(ctx, eventLogout, outcomeError, uid, sid, "err", err, "legacy", true)
		return
	}
	adopted, err := h.db.DeleteUserSessionByLegacyHash(ctx, uid, &presented)
	if err != nil {
		h.logSession(ctx, eventLogout, outcomeError, uid, sid, "err", err, "legacy", true)
		return
	}
	h.logSession(ctx, eventLogout, outcomeEnded, uid, sid, "deleted", cleared+adopted, "legacy", true)
}

// logSession writes the one `auth: session` line per login, refresh and
// logout.  Warn for the two outcomes that may mean a stolen token or a
// library change; error for failures.
func (h *Handlers) logSession(ctx context.Context, event, outcome string, userID, sid uuid.UUID, attrs ...any) {
	level := slog.LevelInfo
	switch outcome {
	case outcomeReuseRevoked, outcomeGraceMismatch:
		level = slog.LevelWarn
	case outcomeError:
		level = slog.LevelError
	}
	args := append([]any{"event", event, "outcome", outcome, "userId", userID, "sid", sid}, attrs...)
	h.log().Log(ctx, level, "auth: session", args...)
}

// log is the handlers' logger: slog.Default() unless a test injected one.
// Resolved per call so a default installed after NewHandlers still applies.
func (h *Handlers) log() *slog.Logger {
	if h.logger != nil {
		return h.logger
	}
	return slog.Default()
}

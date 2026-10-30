package admin

// user_sessions.go — signing an account out from the admin page:
//
//	DELETE /api/admin/users/{userId}/sessions              every device
//	DELETE /api/admin/users/{userId}/sessions/{sessionId}  one device
//
// Both answer {revoked: n}, the signed-in devices they signed out.  Ending a
// session deletes its user_sessions row; the device notices on its next
// request, because jwtx's session check (UserSessionLive) refuses an access
// token whose session is gone, and its refresh token can no longer rotate.
//
// Neither acts on the calling admin's own account: the admin's devices are
// managed from the settings page, where the device being used is known and
// kept.  Here it is not, and "sign everyone out" would include it.

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
	"github.com/lawrenceli0228/animego/go-api/internal/jwtx"
)

const (
	msgInvalidSessionID = "Invalid session ID"
	msgSessionNotFound  = "Session not found"
)

// UserSessionDB is what the session actions need.  *UserStore satisfies it.
//
// RevokeAllUserSessions reports found=false, with nothing written, when the
// account no longer exists.  DeleteUserSession matches the session id AND
// the account, so an id belonging to someone else ends nothing.
type UserSessionDB interface {
	GetUserByID(ctx context.Context, id uuid.UUID) (dbgen.User, error)
	RevokeAllUserSessions(ctx context.Context, userID uuid.UUID) (revoked RevokedSessions, found bool, err error)
	DeleteUserSession(ctx context.Context, iD uuid.UUID, userID uuid.UUID) (int64, error)
}

// RevokedSessions is what RevokeAllUserSessions ended.
type RevokedSessions struct {
	// Live is how many signed-in devices were signed out: the sessions that
	// had not expired, the ones the drawer's device list shows.  Expired rows
	// are deleted too, uncounted.
	Live int64
	// LegacyCleared reports a pre-0052 refresh token cleared from the users
	// row.  It is not in Live: the device list cannot show it, and nothing on
	// the row says whether it has already expired.
	LegacyCleared bool
}

// UserSessionHandlers carries the session actions' store.
type UserSessionHandlers struct {
	db UserSessionDB
}

// NewUserSessionHandlers panics on a nil store, at boot rather than on the
// first request, like the other constructors here.
func NewUserSessionHandlers(db UserSessionDB) *UserSessionHandlers {
	if db == nil {
		panic("admin.NewUserSessionHandlers: nil UserSessionDB")
	}
	return &UserSessionHandlers{db: db}
}

// revokedSessionsResp is AdminRevokeSessionsResult.
type revokedSessionsResp struct {
	Revoked int64 `json:"revoked"`
}

// RevokeUserSessions implements DELETE /api/admin/users/{userId}/sessions:
// ends every session of the account, including a pre-0052 refresh token
// still held on its users row.  revoked counts the live sessions ended (see
// RevokedSessions); the audit line also says whether a legacy token went.
func (h *UserSessionHandlers) RevokeUserSessions(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), userQueryTimeout)
	defer cancel()

	userID, ok := parseUserID(w, r)
	if !ok {
		return
	}
	claims, username, ok := h.sessionTarget(ctx, w, r, userID)
	if !ok {
		return
	}

	res, found, err := h.db.RevokeAllUserSessions(ctx, userID)
	if err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "revoke sessions failed"))
		return
	}
	if !found {
		// Deleted by someone else between the lookup and the lock.
		httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, msgUserNotFound))
		return
	}

	slog.InfoContext(r.Context(), "admin revoked user sessions",
		"admin", claims.Username, "username", username,
		"revoked", res.Live, "legacyCleared", res.LegacyCleared)
	httpx.Data(w, http.StatusOK, revokedSessionsResp{Revoked: res.Live})
}

// RevokeUserSession implements DELETE
// /api/admin/users/{userId}/sessions/{sessionId}: ends one session of the
// account.  404 when the account has no such session — including when the
// id is another account's, which this route never ends.
func (h *UserSessionHandlers) RevokeUserSession(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), userQueryTimeout)
	defer cancel()

	userID, ok := parseUserID(w, r)
	if !ok {
		return
	}
	sessionID, err := uuid.Parse(chi.URLParam(r, "sessionId"))
	if err != nil {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, msgInvalidSessionID))
		return
	}
	claims, username, ok := h.sessionTarget(ctx, w, r, userID)
	if !ok {
		return
	}

	n, err := h.db.DeleteUserSession(ctx, sessionID, userID)
	if err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "revoke session failed"))
		return
	}
	if n == 0 {
		httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, msgSessionNotFound))
		return
	}

	slog.InfoContext(r.Context(), "admin revoked user session",
		"admin", claims.Username, "username", username, "sid", sessionID, "revoked", n)
	httpx.Data(w, http.StatusOK, revokedSessionsResp{Revoked: n})
}

// sessionTarget checks who is asking and about whom, and writes the failure
// itself: 500 without claims (the route is mounted outside RequireAuth — a
// wiring bug, not a permission problem), 400 for the admin's own account,
// 404 when the account does not exist.  It hands back only the account's
// username, for the audit line: the users row also carries credential
// columns, and nothing here should be one edit away from serialising them.
func (h *UserSessionHandlers) sessionTarget(ctx context.Context, w http.ResponseWriter, r *http.Request, userID uuid.UUID) (*jwtx.AccessClaims, string, bool) {
	claims, ok := jwtx.ClaimsFrom(r.Context())
	if !ok || claims == nil {
		httpx.Fail(w, httpx.NewError(http.StatusInternalServerError, httpx.CodeServerError, "missing auth claims"))
		return nil, "", false
	}
	if claims.UserID == userID {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, msgCannotRevokeSelf))
		return nil, "", false
	}
	user, err := h.db.GetUserByID(ctx, userID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, msgUserNotFound))
			return nil, "", false
		}
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "user lookup failed"))
		return nil, "", false
	}
	return claims, user.Username, true
}

// RevokeAllUserSessions ends every session of the account in one
// transaction, in auth.Store.RevokeOtherSessions' order without the kept
// session: lock the users row, clear a pre-0052 refresh token still held on
// it, delete every user_sessions row.  Returns what ended (RevokedSessions).
//
// The lock is what makes "every" true.  A legacy token being adopted into a
// session either commits first (and its new session is deleted here) or
// waits and finds its token cleared; a login opening a session either
// commits first (and is signed out here) or waits and opens it after.
//
// READ COMMITTED is load-bearing, so it is stated rather than inherited: each
// statement takes a fresh snapshot, which is how the delete sees a session
// committed while the lock was being waited for.  Under REPEATABLE READ the
// snapshot would predate the wait and that session would survive, silently.
func (s *UserStore) RevokeAllUserSessions(ctx context.Context, userID uuid.UUID) (RevokedSessions, bool, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return RevokedSessions{}, false, fmt.Errorf("admin: begin revoke sessions: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	q := dbgen.New(tx)
	if _, err := q.LockUserForRevoke(ctx, userID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return RevokedSessions{}, false, nil
		}
		return RevokedSessions{}, false, fmt.Errorf("admin: lock user for revoke: %w", err)
	}
	legacy, err := q.ClearLegacyRefreshTokens(ctx, userID)
	if err != nil {
		return RevokedSessions{}, false, fmt.Errorf("admin: clear legacy session: %w", err)
	}
	live, err := q.DeleteAllUserSessions(ctx, userID)
	if err != nil {
		return RevokedSessions{}, false, fmt.Errorf("admin: delete sessions: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return RevokedSessions{}, false, fmt.Errorf("admin: commit revoke sessions: %w", err)
	}
	return RevokedSessions{Live: live, LegacyCleared: legacy > 0}, true, nil
}

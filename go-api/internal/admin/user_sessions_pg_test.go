package admin

// user_sessions_pg_test.go — the session actions against the real schema:
// what revoke-all ends (live and expired rows, the pre-0052 token on the
// users row), that the access-token check then refuses the device, that
// revoke-one ends exactly one row of exactly this account, and that the
// users-row lock makes a login in flight end up signed out too.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/auth"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/jwtx"
)

func newSessionHandlersForPG(t *testing.T) (*UserSessionHandlers, *pgxpool.Pool) {
	t.Helper()
	pool := newStorePool(t)
	return NewUserSessionHandlers(NewUserStore(pool)), pool
}

func liveSession(t *testing.T, pool *pgxpool.Pool, userID uuid.UUID) uuid.UUID {
	t.Helper()
	now := time.Now()
	return seedSession(t, pool, userID, sessionSeed{LastUsed: now.Add(-time.Minute), Expires: now.Add(30 * 24 * time.Hour)})
}

func sessionLive(t *testing.T, pool *pgxpool.Pool, sid, userID uuid.UUID) bool {
	t.Helper()
	live, err := dbgen.New(pool).UserSessionLive(context.Background(), sid, userID)
	require.NoError(t, err)
	return live
}

func TestRevokeUserSessions_EndsEverySessionAndTheLegacyToken_PG(t *testing.T) {
	h, pool := newSessionHandlersForPG(t)
	target := seedUser(t, pool, "revoke_target", "revoke_target@example.com")
	bystander := seedUser(t, pool, "revoke_bystander", "revoke_bystander@example.com")

	first := liveSession(t, pool, target)
	second := liveSession(t, pool, target)
	now := time.Now()
	seedSession(t, pool, target, sessionSeed{LastUsed: now.Add(-48 * time.Hour), Expires: now.Add(-time.Hour)})
	kept := liveSession(t, pool, bystander)
	// A refresh token from before per-device sessions, still on the row.
	execOK(t, pool, `UPDATE users SET refresh_token = 'legacy-current', previous_refresh_token = 'legacy-previous',
		refresh_rotated_at = now() WHERE id = $1`, target)
	require.True(t, sessionLive(t, pool, first, target))

	rec := revokeAll(h, sessionRequest(t, target.String(), "", false))

	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Equal(t, `{"data":{"revoked":4}}`, rec.Body.String(), "three session rows and the legacy token")
	assert.Equal(t, int64(0), countRows(t, pool, `SELECT count(*) FROM user_sessions WHERE user_id = $1`, target))
	assert.Equal(t, int64(0), countRows(t, pool, `SELECT count(*) FROM users WHERE id = $1
		AND (refresh_token IS NOT NULL OR previous_refresh_token IS NOT NULL OR refresh_rotated_at IS NOT NULL)`, target))
	// The device's next request is refused: jwtx asks exactly this.
	assert.False(t, sessionLive(t, pool, first, target))
	assert.False(t, sessionLive(t, pool, second, target))
	assert.True(t, sessionLive(t, pool, kept, bystander), "another account is untouched")

	// Nothing left to end is still an answer.
	rec = revokeAll(h, sessionRequest(t, target.String(), "", false))
	assert.Equal(t, `{"data":{"revoked":0}}`, rec.Body.String())
}

func TestRevokeUserSession_EndsOnlyThatSession_PG(t *testing.T) {
	h, pool := newSessionHandlersForPG(t)
	target := seedUser(t, pool, "one_target", "one_target@example.com")
	other := seedUser(t, pool, "one_other", "one_other@example.com")
	s1 := liveSession(t, pool, target)
	s2 := liveSession(t, pool, target)
	s3 := liveSession(t, pool, other)
	execOK(t, pool, `UPDATE users SET refresh_token = 'legacy-current' WHERE id = $1`, target)

	rec := revokeOne(h, sessionRequest(t, target.String(), s1.String(), false))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Equal(t, `{"data":{"revoked":1}}`, rec.Body.String())
	assert.False(t, sessionLive(t, pool, s1, target))
	assert.True(t, sessionLive(t, pool, s2, target), "the account's other device stays signed in")
	assert.Equal(t, int64(1), countRows(t, pool, `SELECT count(*) FROM users WHERE id = $1 AND refresh_token IS NOT NULL`, target),
		"ending one device leaves the legacy token alone")

	// Another account's session, named under this account: 404, and it lives.
	rec = revokeOne(h, sessionRequest(t, target.String(), s3.String(), false))
	assertErrorEnvelope(t, rec, http.StatusNotFound, "NOT_FOUND", "Session not found")
	assert.True(t, sessionLive(t, pool, s3, other))

	// Already ended.
	rec = revokeOne(h, sessionRequest(t, target.String(), s1.String(), false))
	assertErrorEnvelope(t, rec, http.StatusNotFound, "NOT_FOUND", "Session not found")
}

func TestSessionActions_RefuseTheCallingAdmin_PG(t *testing.T) {
	h, pool := newSessionHandlersForPG(t)
	var admin uuid.UUID
	require.NoError(t, pool.QueryRow(context.Background(), `
		INSERT INTO users (id, username, email, password, role)
		VALUES ($1, 'self_admin', 'self_admin@example.com', 'x', 'admin') RETURNING id`, sessionAdminID).Scan(&admin))
	sid := liveSession(t, pool, admin)

	assertErrorEnvelope(t, revokeAll(h, sessionRequest(t, admin.String(), "", false)),
		http.StatusBadRequest, "BAD_REQUEST", "Cannot sign yourself out here")
	assertErrorEnvelope(t, revokeOne(h, sessionRequest(t, admin.String(), sid.String(), false)),
		http.StatusBadRequest, "BAD_REQUEST", "Cannot sign yourself out here")
	assert.True(t, sessionLive(t, pool, sid, admin))
}

func TestSessionActions_UnknownAccount_404_PG(t *testing.T) {
	h, _ := newSessionHandlersForPG(t)
	assertErrorEnvelope(t, revokeAll(h, sessionRequest(t, uuid.NewString(), "", false)),
		http.StatusNotFound, "NOT_FOUND", "User not found")
	assertErrorEnvelope(t, revokeOne(h, sessionRequest(t, uuid.NewString(), uuid.NewString(), false)),
		http.StatusNotFound, "NOT_FOUND", "User not found")
}

func TestRevokeAllUserSessions_MissingAccount_PG(t *testing.T) {
	pool := newStorePool(t)
	n, found, err := NewUserStore(pool).RevokeAllUserSessions(context.Background(), uuid.New())
	require.NoError(t, err)
	assert.False(t, found)
	assert.Zero(t, n)
}

// A login holds the users row FOR SHARE while it writes its session
// (auth.Store.StartUserSession).  Revoke-all locks the row before deleting,
// so it waits for that login and then deletes its session too; deleting
// first would miss the uncommitted row and leave the device signed in.
//
// The lock is held until the revoke is seen waiting on it in
// pg_stat_activity, so the interleaving is forced, not hoped for.
func TestRevokeAllUserSessions_SignsOutALoginInFlight_PG(t *testing.T) {
	pool := newStorePool(t)
	ctx := context.Background()
	user := seedUser(t, pool, "race_target", "race_target@example.com")

	login, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer func() { _ = login.Rollback(ctx) }()
	_, err = dbgen.New(login).LockUserForNewSession(ctx, user, "bcrypt-placeholder")
	require.NoError(t, err)
	now := time.Now()
	sid := uuid.New()
	require.NoError(t, dbgen.New(login).CreateUserSession(ctx, dbgen.CreateUserSessionParams{
		ID: sid, UserID: user, TokenHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		TokenJti: uuid.New(), TokenIat: ts(now), TokenExp: ts(now.Add(30 * 24 * time.Hour)),
	}))

	type result struct {
		n     int64
		found bool
		err   error
	}
	done := make(chan result, 1)
	go func() {
		n, found, err := NewUserStore(pool).RevokeAllUserSessions(ctx, user)
		done <- result{n, found, err}
	}()

	// Polled with a plain query: the condition runs off the test goroutine,
	// where require must not be called.
	require.Eventually(t, func() bool {
		var waiting int64
		err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity
			WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock'
			  AND query LIKE '%LockUserForRevoke%'`).Scan(&waiting)
		return err == nil && waiting == 1
	}, 10*time.Second, 10*time.Millisecond, "revoke never blocked on the login's row lock")
	select {
	case r := <-done:
		t.Fatalf("revoke finished while the login still held the row: %+v", r)
	default:
	}

	require.NoError(t, login.Commit(ctx))

	select {
	case r := <-done:
		require.NoError(t, r.err)
		assert.True(t, r.found)
		assert.Equal(t, int64(1), r.n, "the session the login committed is the one revoked")
	case <-time.After(10 * time.Second):
		t.Fatal("revoke did not finish after the login committed")
	}
	assert.False(t, sessionLive(t, pool, sid, user))
}

// Through the real middleware, the way the routes are mounted in main.go:
// RequireAuth with the session check, then RequireAdmin.  Revoking the
// account's sessions signs its device out on the device's very next
// request, and a non-admin cannot reach the route at all.
func TestRevokeUserSessions_TheDevicesNextRequestIsRefused_PG(t *testing.T) {
	h, pool := newSessionHandlersForPG(t)
	base, err := jwtx.NewSigner("test-access-secret", "test-refresh-secret", 15*time.Minute, time.Hour)
	require.NoError(t, err)
	signer := base.WithSessionCheck(auth.NewStore(pool))

	role := "admin"
	admin := seedUser(t, pool, "mw_admin", "mw_admin@example.com")
	setRole(t, pool, admin, role)
	adminToken, err := signer.SignAccess(admin, liveSession(t, pool, admin), "mw_admin", &role)
	require.NoError(t, err)
	target := seedUser(t, pool, "mw_target", "mw_target@example.com")
	targetToken, err := signer.SignAccess(target, liveSession(t, pool, target), "mw_target", nil)
	require.NoError(t, err)

	r := chi.NewRouter()
	r.Route("/api/admin", func(r chi.Router) {
		r.Use(jwtx.RequireAuth(signer))
		r.Use(jwtx.RequireAdmin())
		r.Delete("/users/{userId}/sessions", h.RevokeUserSessions)
		r.Delete("/users/{userId}/sessions/{sessionId}", h.RevokeUserSession)
	})
	r.With(jwtx.RequireAuth(signer)).Get("/api/probe", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	call := func(method, path, token string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, nil)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec
	}

	require.Equal(t, http.StatusNoContent, call(http.MethodGet, "/api/probe", targetToken).Code)
	assert.Equal(t, http.StatusUnauthorized, call(http.MethodDelete, "/api/admin/users/"+admin.String()+"/sessions", "").Code)
	assert.Equal(t, http.StatusForbidden, call(http.MethodDelete, "/api/admin/users/"+admin.String()+"/sessions", targetToken).Code,
		"a reader cannot sign the admin out")

	rec := call(http.MethodDelete, "/api/admin/users/"+target.String()+"/sessions", adminToken)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Equal(t, `{"data":{"revoked":1}}`, rec.Body.String())

	assert.Equal(t, http.StatusUnauthorized, call(http.MethodGet, "/api/probe", targetToken).Code,
		"the revoked device is refused on its next request, not when its token runs out")
	assert.Equal(t, http.StatusNoContent, call(http.MethodGet, "/api/probe", adminToken).Code)
}

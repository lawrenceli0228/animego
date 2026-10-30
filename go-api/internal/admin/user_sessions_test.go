package admin

// user_sessions_test.go — the session actions' request handling against a
// fake store: the order of the checks (bad ids, the admin's own account, a
// missing account or session), the response, and the audit line.
// user_sessions_pg_test.go runs the real transaction.

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

type fakeSessionDB struct {
	userErr   error
	revoked   int64
	missing   bool // RevokeAllUserSessions finds no account
	revokeErr error
	deleted   int64
	deleteErr error

	lookups, revokes, deletes int
	gotSession, gotUser       uuid.UUID
}

func (f *fakeSessionDB) GetUserByID(_ context.Context, id uuid.UUID) (dbgen.User, error) {
	f.lookups++
	if f.userErr != nil {
		return dbgen.User{}, f.userErr
	}
	return dbgen.User{ID: id, Username: "target_user"}, nil
}

func (f *fakeSessionDB) RevokeAllUserSessions(_ context.Context, userID uuid.UUID) (int64, bool, error) {
	f.revokes++
	f.gotUser = userID
	return f.revoked, !f.missing, f.revokeErr
}

func (f *fakeSessionDB) DeleteUserSession(_ context.Context, id, userID uuid.UUID) (int64, error) {
	f.deletes++
	f.gotSession, f.gotUser = id, userID
	return f.deleted, f.deleteErr
}

var sessionAdminID = uuid.MustParse("11111111-2222-4333-8444-555555555555")

// sessionRequest builds a DELETE with the route's URL params and, unless
// anonymous, the claims RequireAuth would have put on it for the admin.
func sessionRequest(t *testing.T, userID, sessionID string, anonymous bool) *http.Request {
	t.Helper()
	target := "/api/admin/users/" + userID + "/sessions"
	rc := chi.NewRouteContext()
	rc.URLParams.Add("userId", userID)
	if sessionID != "" {
		target += "/" + sessionID
		rc.URLParams.Add("sessionId", sessionID)
	}
	ctx := context.Background()
	if !anonymous {
		ctx = withAdminClaims(t, ctx, sessionAdminID, "root_admin")
	}
	ctx = context.WithValue(ctx, chi.RouteCtxKey, rc)
	return httptest.NewRequest(http.MethodDelete, target, nil).WithContext(ctx)
}

func revokeAll(h *UserSessionHandlers, r *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.RevokeUserSessions(rec, r)
	return rec
}

func revokeOne(h *UserSessionHandlers, r *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.RevokeUserSession(rec, r)
	return rec
}

func TestRevokeUserSessions_AnswersTheCount(t *testing.T) {
	t.Parallel()
	db := &fakeSessionDB{revoked: 3}
	target := uuid.New()
	rec := revokeAll(NewUserSessionHandlers(db), sessionRequest(t, target.String(), "", false))

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, `{"data":{"revoked":3}}`, rec.Body.String())
	assert.Equal(t, 1, db.revokes)
	assert.Equal(t, target, db.gotUser)
}

func TestRevokeUserSession_AnswersOne(t *testing.T) {
	t.Parallel()
	db := &fakeSessionDB{deleted: 1}
	target, sid := uuid.New(), uuid.New()
	rec := revokeOne(NewUserSessionHandlers(db), sessionRequest(t, target.String(), sid.String(), false))

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, `{"data":{"revoked":1}}`, rec.Body.String())
	assert.Equal(t, sid, db.gotSession)
	assert.Equal(t, target, db.gotUser, "the delete is scoped to the account in the path")
}

// The admin's own account is refused before anything is read or written.
func TestSessionActions_RefuseTheCallingAdmin(t *testing.T) {
	t.Parallel()
	db := &fakeSessionDB{revoked: 1, deleted: 1}
	h := NewUserSessionHandlers(db)

	rec := revokeAll(h, sessionRequest(t, sessionAdminID.String(), "", false))
	assertErrorEnvelope(t, rec, http.StatusBadRequest, "BAD_REQUEST", "Cannot sign yourself out here")
	rec = revokeOne(h, sessionRequest(t, sessionAdminID.String(), uuid.NewString(), false))
	assertErrorEnvelope(t, rec, http.StatusBadRequest, "BAD_REQUEST", "Cannot sign yourself out here")

	assert.Zero(t, db.lookups+db.revokes+db.deletes)
}

func TestSessionActions_MalformedIDs_400(t *testing.T) {
	t.Parallel()
	db := &fakeSessionDB{}
	h := NewUserSessionHandlers(db)

	assertErrorEnvelope(t, revokeAll(h, sessionRequest(t, "not-a-uuid", "", false)),
		http.StatusBadRequest, "BAD_REQUEST", "Invalid user ID")
	assertErrorEnvelope(t, revokeOne(h, sessionRequest(t, "not-a-uuid", uuid.NewString(), false)),
		http.StatusBadRequest, "BAD_REQUEST", "Invalid user ID")
	assertErrorEnvelope(t, revokeOne(h, sessionRequest(t, uuid.NewString(), "not-a-uuid", false)),
		http.StatusBadRequest, "BAD_REQUEST", "Invalid session ID")
	assert.Zero(t, db.lookups+db.revokes+db.deletes)
}

// Without claims the route is mounted outside RequireAuth: a wiring bug,
// reported as one rather than as a permissions answer.
func TestSessionActions_MissingClaims_500(t *testing.T) {
	t.Parallel()
	db := &fakeSessionDB{}
	h := NewUserSessionHandlers(db)
	assert.Equal(t, http.StatusInternalServerError, revokeAll(h, sessionRequest(t, uuid.NewString(), "", true)).Code)
	assert.Equal(t, http.StatusInternalServerError, revokeOne(h, sessionRequest(t, uuid.NewString(), uuid.NewString(), true)).Code)
	assert.Zero(t, db.lookups+db.revokes+db.deletes)
}

func TestSessionActions_UnknownAccount_404(t *testing.T) {
	t.Parallel()
	db := &fakeSessionDB{userErr: pgx.ErrNoRows}
	h := NewUserSessionHandlers(db)

	assertErrorEnvelope(t, revokeAll(h, sessionRequest(t, uuid.NewString(), "", false)),
		http.StatusNotFound, "NOT_FOUND", "User not found")
	assertErrorEnvelope(t, revokeOne(h, sessionRequest(t, uuid.NewString(), uuid.NewString(), false)),
		http.StatusNotFound, "NOT_FOUND", "User not found")
	assert.Zero(t, db.revokes+db.deletes)
}

// Deleted between the lookup and the transaction's lock.
func TestRevokeUserSessions_AccountGoneMidway_404(t *testing.T) {
	t.Parallel()
	db := &fakeSessionDB{missing: true}
	rec := revokeAll(NewUserSessionHandlers(db), sessionRequest(t, uuid.NewString(), "", false))
	assertErrorEnvelope(t, rec, http.StatusNotFound, "NOT_FOUND", "User not found")
}

// No such session on this account — including another account's session.
func TestRevokeUserSession_UnknownSession_404(t *testing.T) {
	t.Parallel()
	db := &fakeSessionDB{deleted: 0}
	rec := revokeOne(NewUserSessionHandlers(db), sessionRequest(t, uuid.NewString(), uuid.NewString(), false))
	assertErrorEnvelope(t, rec, http.StatusNotFound, "NOT_FOUND", "Session not found")
}

func TestSessionActions_StoreErrors_500(t *testing.T) {
	t.Parallel()
	boom := errors.New("boom")
	cases := []struct {
		name string
		db   *fakeSessionDB
		one  bool
	}{
		{"lookup, all", &fakeSessionDB{userErr: boom}, false},
		{"lookup, one", &fakeSessionDB{userErr: boom}, true},
		{"revoke", &fakeSessionDB{revokeErr: boom}, false},
		{"delete", &fakeSessionDB{deleteErr: boom}, true},
	}
	for _, tc := range cases {
		h := NewUserSessionHandlers(tc.db)
		var rec *httptest.ResponseRecorder
		if tc.one {
			rec = revokeOne(h, sessionRequest(t, uuid.NewString(), uuid.NewString(), false))
		} else {
			rec = revokeAll(h, sessionRequest(t, uuid.NewString(), "", false))
		}
		assert.Equal(t, http.StatusInternalServerError, rec.Code, tc.name)
		assert.Contains(t, rec.Body.String(), `"SERVER_ERROR"`, tc.name)
		assert.NotContains(t, rec.Body.String(), "boom", "%s: the cause stays in the log", tc.name)
	}
}

func TestNewUserSessionHandlers_NilStorePanics(t *testing.T) {
	t.Parallel()
	assert.Panics(t, func() { NewUserSessionHandlers(nil) })
}

// recordingHandler keeps the records it is handed; safe for concurrent use.
type recordingHandler struct {
	mu      sync.Mutex
	records []slog.Record
}

func (h *recordingHandler) Enabled(context.Context, slog.Level) bool { return true }
func (h *recordingHandler) Handle(_ context.Context, r slog.Record) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.records = append(h.records, r.Clone())
	return nil
}
func (h *recordingHandler) WithAttrs([]slog.Attr) slog.Handler { return h }
func (h *recordingHandler) WithGroup(string) slog.Handler      { return h }

func (h *recordingHandler) find(msg string) (map[string]string, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, r := range h.records {
		if r.Message != msg {
			continue
		}
		attrs := map[string]string{}
		r.Attrs(func(a slog.Attr) bool {
			attrs[a.Key] = a.Value.String()
			return true
		})
		return attrs, true
	}
	return nil, false
}

// Every revoke leaves an audit line naming the admin, the account and the
// count.  Not parallel: it swaps the default logger, and parallel tests are
// held until the sequential ones have finished.
func TestSessionActions_WriteAnAuditLine(t *testing.T) {
	rec := &recordingHandler{}
	prev := slog.Default()
	slog.SetDefault(slog.New(rec))
	t.Cleanup(func() { slog.SetDefault(prev) })

	h := NewUserSessionHandlers(&fakeSessionDB{revoked: 2, deleted: 1})
	require.Equal(t, http.StatusOK, revokeAll(h, sessionRequest(t, uuid.NewString(), "", false)).Code)
	sid := uuid.New()
	require.Equal(t, http.StatusOK, revokeOne(h, sessionRequest(t, uuid.NewString(), sid.String(), false)).Code)

	all, ok := rec.find("admin revoked user sessions")
	require.True(t, ok, "no audit line for revoke-all")
	assert.Equal(t, map[string]string{"admin": "root_admin", "username": "target_user", "revoked": "2"}, all)

	one, ok := rec.find("admin revoked user session")
	require.True(t, ok, "no audit line for revoke-one")
	assert.Equal(t, map[string]string{"admin": "root_admin", "username": "target_user", "sid": sid.String(), "revoked": "1"}, one)
}

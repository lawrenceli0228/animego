package admin

// users_test.go — table-driven tests for the user-CRUD admin handlers.
// Tests substitute a fakeUserDB (function-pointer fields) for the
// dbgen surface so no Postgres dependency is required.  Chinese
// messages are asserted byte-exact to catch any silent translation
// drift that would break the shadow-traffic diff at cutover.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/jwtx"
	"github.com/lawrenceli0228/animego/go-api/internal/queue"
)

// fakeUserDB is a function-pointer mock matching the UserDB interface.
// Per-test setup overrides the fields it cares about; unset fields
// panic if invoked so missing wiring is caught immediately.
type fakeUserDB struct {
	mu sync.Mutex

	adminCreateUserFn         func(ctx context.Context, username, email, password string) (dbgen.AdminCreateUserRow, error)
	adminUpdateUserFn         func(ctx context.Context, username, email *string, userID uuid.UUID) (dbgen.AdminUpdateUserRow, error)
	adminDeleteUserFn         func(ctx context.Context, id uuid.UUID) error
	adminFindFn               func(ctx context.Context, username, email *string) (dbgen.AdminFindUserByUsernameOrEmailRow, error)
	adminFindExcludingFn      func(ctx context.Context, username, email *string, excludeID uuid.UUID) (dbgen.AdminFindUserByUsernameOrEmailExcludingRow, error)
	getUserByIDFn             func(ctx context.Context, id uuid.UUID) (dbgen.User, error)
	adminSetPasswordFn        func(ctx context.Context, id uuid.UUID, password string) error
	adminDeleteUserCallCount  int32
	adminCreateUserCallCount  int32
	adminUpdateUserCallCount  int32
	adminSetPasswordCallCount int32
}

func (f *fakeUserDB) AdminCreateUser(ctx context.Context, username, email, password string) (dbgen.AdminCreateUserRow, error) {
	atomic.AddInt32(&f.adminCreateUserCallCount, 1)
	if f.adminCreateUserFn == nil {
		panic("fakeUserDB.AdminCreateUser not set")
	}
	return f.adminCreateUserFn(ctx, username, email, password)
}

func (f *fakeUserDB) AdminUpdateUser(ctx context.Context, username, email *string, userID uuid.UUID) (dbgen.AdminUpdateUserRow, error) {
	atomic.AddInt32(&f.adminUpdateUserCallCount, 1)
	if f.adminUpdateUserFn == nil {
		panic("fakeUserDB.AdminUpdateUser not set")
	}
	return f.adminUpdateUserFn(ctx, username, email, userID)
}

func (f *fakeUserDB) AdminDeleteUser(ctx context.Context, id uuid.UUID) error {
	atomic.AddInt32(&f.adminDeleteUserCallCount, 1)
	if f.adminDeleteUserFn == nil {
		panic("fakeUserDB.AdminDeleteUser not set")
	}
	return f.adminDeleteUserFn(ctx, id)
}

func (f *fakeUserDB) AdminFindUserByUsernameOrEmail(ctx context.Context, username, email *string) (dbgen.AdminFindUserByUsernameOrEmailRow, error) {
	if f.adminFindFn == nil {
		panic("fakeUserDB.AdminFindUserByUsernameOrEmail not set")
	}
	return f.adminFindFn(ctx, username, email)
}

func (f *fakeUserDB) AdminFindUserByUsernameOrEmailExcluding(ctx context.Context, username, email *string, excludeID uuid.UUID) (dbgen.AdminFindUserByUsernameOrEmailExcludingRow, error) {
	if f.adminFindExcludingFn == nil {
		panic("fakeUserDB.AdminFindUserByUsernameOrEmailExcluding not set")
	}
	return f.adminFindExcludingFn(ctx, username, email, excludeID)
}

func (f *fakeUserDB) GetUserByID(ctx context.Context, id uuid.UUID) (dbgen.User, error) {
	if f.getUserByIDFn == nil {
		panic("fakeUserDB.GetUserByID not set")
	}
	return f.getUserByIDFn(ctx, id)
}

func (f *fakeUserDB) AdminSetUserPassword(ctx context.Context, id uuid.UUID, password string) error {
	atomic.AddInt32(&f.adminSetPasswordCallCount, 1)
	if f.adminSetPasswordFn == nil {
		return nil
	}
	return f.adminSetPasswordFn(ctx, id, password)
}

// fakeEnqueuer satisfies queue.Enqueuer with no-op stubs.  The
// user-CRUD endpoints don't actually exercise the queue surface — the
// dependency exists for shared wiring with WarmAll.  WarmAll-specific
// tests use a richer fake in warm_all_test.go.
type fakeEnqueuer struct{}

func (fakeEnqueuer) EnqueueV1Many(_ context.Context, _ []int32) error            { return nil }
func (fakeEnqueuer) EnqueueV2Many(_ context.Context, _ []queue.BangumiV2Args) error { return nil }
func (fakeEnqueuer) EnqueueV3Many(_ context.Context, _ []queue.BangumiV3Args) error { return nil }
func (fakeEnqueuer) EnqueueWarmSeasonNow(_ context.Context, _ queue.WarmSeasonArgs) error {
	return nil
}

// fixtureCreateRow builds a dbgen.AdminCreateUserRow with the supplied
// inputs.  Used by happy-path tests that need a stable RETURNING row.
func fixtureCreateRow(t *testing.T, username, email string) dbgen.AdminCreateUserRow {
	t.Helper()
	id := uuid.MustParse("11111111-1111-1111-1111-111111111111")
	return dbgen.AdminCreateUserRow{
		ID:       id,
		Username: username,
		Email:    email,
	}
}

// fixtureUpdateRow builds a dbgen.AdminUpdateUserRow.  Role is nil to
// model the default non-admin user; tests that need role="admin" can
// override after calling this builder.
func fixtureUpdateRow(t *testing.T, id uuid.UUID, username, email string) dbgen.AdminUpdateUserRow {
	t.Helper()
	created := pgtype.Timestamptz{
		Time:  time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC),
		Valid: true,
	}
	return dbgen.AdminUpdateUserRow{
		ID:        id,
		Username:  username,
		Email:     email,
		Role:      nil,
		CreatedAt: created,
	}
}

// fixtureUser builds a dbgen.User for the DeleteUser pre-check path.
func fixtureDBUser(t *testing.T, id uuid.UUID, username string) dbgen.User {
	t.Helper()
	now := pgtype.Timestamptz{Time: time.Now(), Valid: true}
	return dbgen.User{
		ID:        id,
		Username:  username,
		Email:     username + "@example.com",
		Password:  "$2a$10$placeholder",
		IsPublic:  true,
		CreatedAt: now,
		UpdatedAt: now,
	}
}

// requestWithUserID wraps a request with the userId chi URL param
// pre-populated.  Necessary because chi.URLParam(r, "userId") relies
// on a chi-specific route context that must be installed manually in
// unit tests that don't go through the router.
func requestWithUserID(t *testing.T, method, target, body, userID string) *http.Request {
	t.Helper()
	var b *bytes.Buffer
	if body != "" {
		b = bytes.NewBufferString(body)
	} else {
		b = &bytes.Buffer{}
	}
	req := httptest.NewRequest(method, target, b)
	if userID != "" {
		rc := chi.NewRouteContext()
		rc.URLParams.Add("userId", userID)
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))
	}
	return req
}

// withAdminClaims signs a real JWT for the given userId+username and
// runs it through jwtx.RequireAuth, then returns the populated request
// context.  Mirrors the pattern in internal/auth/handlers_test.go's
// injectClaims helper.
func withAdminClaims(t *testing.T, ctx context.Context, userID uuid.UUID, username string) context.Context {
	t.Helper()
	signer, err := jwtx.NewSigner("test-access-secret", "test-refresh-secret", 15*time.Minute, time.Hour)
	if err != nil {
		t.Fatalf("NewSigner: %v", err)
	}
	role := "admin"
	tok, err := signer.SignAccess(userID, username, &role)
	if err != nil {
		t.Fatalf("SignAccess: %v", err)
	}
	var captured context.Context
	mw := jwtx.RequireAuth(signer)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured = r.Context()
	}))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	req = req.WithContext(ctx)
	handler.ServeHTTP(httptest.NewRecorder(), req)
	if captured == nil {
		t.Fatalf("withAdminClaims: jwtx.RequireAuth did not populate ctx")
	}
	return captured
}

// decodeDataInto JSON-decodes the {"data":...} envelope into target.
func decodeDataInto(t *testing.T, body []byte, target any) {
	t.Helper()
	var env struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		t.Fatalf("unmarshal envelope: %v; body=%s", err, body)
	}
	if err := json.Unmarshal(env.Data, target); err != nil {
		t.Fatalf("unmarshal data: %v; data=%s", err, env.Data)
	}
}

// assertErrorEnvelope verifies the 4xx/5xx response envelope shape +
// the exact byte-for-byte Chinese message.
func assertErrorEnvelope(t *testing.T, rec *httptest.ResponseRecorder, wantStatus int, wantCode, wantMsg string) {
	t.Helper()
	if rec.Code != wantStatus {
		t.Errorf("status = %d, want %d; body=%s", rec.Code, wantStatus, rec.Body.String())
	}
	want := `{"error":{"code":"` + wantCode + `","message":"` + wantMsg + `"}}`
	if got := rec.Body.String(); got != want {
		t.Errorf("body mismatch\n got: %s\nwant: %s", got, want)
	}
}

// -----------------------------------------------------------------------------
// CreateUser
// -----------------------------------------------------------------------------

func TestCreateUser_HappyPath_201(t *testing.T) {
	t.Parallel()
	want := fixtureCreateRow(t, "lawrence", "lawrence@example.com")
	db := &fakeUserDB{
		adminFindFn: func(_ context.Context, _, _ *string) (dbgen.AdminFindUserByUsernameOrEmailRow, error) {
			return dbgen.AdminFindUserByUsernameOrEmailRow{}, pgx.ErrNoRows
		},
		adminCreateUserFn: func(_ context.Context, username, email, password string) (dbgen.AdminCreateUserRow, error) {
			if username != "lawrence" || email != "lawrence@example.com" {
				t.Errorf("input mismatch: %s %s", username, email)
			}
			if !strings.HasPrefix(password, "$2a$10$") && !strings.HasPrefix(password, "$2b$10$") {
				t.Errorf("password not bcrypt-hashed at cost=10: %s", password)
			}
			return want, nil
		},
	}
	h := NewUserHandlers(db, fakeEnqueuer{})

	req := httptest.NewRequest(http.MethodPost, "/api/admin/users",
		bytes.NewBufferString(`{"username":"lawrence","email":"lawrence@example.com","password":"some-passphrase"}`))
	rec := httptest.NewRecorder()
	h.CreateUser(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body=%s", rec.Code, rec.Body.String())
	}

	var got createUserResp
	decodeDataInto(t, rec.Body.Bytes(), &got)
	if got.Username != want.Username || got.Email != want.Email {
		t.Errorf("response mismatch: %+v vs %+v", got, want)
	}
	if got.ID == uuid.Nil {
		t.Error("ID is uuid.Nil — RETURNING projection wasn't passed through")
	}
}

func TestCreateUser_RespondsWithUnderscoreIDField(t *testing.T) {
	t.Parallel()
	want := fixtureCreateRow(t, "lawrence", "lawrence@example.com")
	db := &fakeUserDB{
		adminFindFn: func(_ context.Context, _, _ *string) (dbgen.AdminFindUserByUsernameOrEmailRow, error) {
			return dbgen.AdminFindUserByUsernameOrEmailRow{}, pgx.ErrNoRows
		},
		adminCreateUserFn: func(_ context.Context, _, _, _ string) (dbgen.AdminCreateUserRow, error) {
			return want, nil
		},
	}
	h := NewUserHandlers(db, fakeEnqueuer{})

	req := httptest.NewRequest(http.MethodPost, "/api/admin/users",
		bytes.NewBufferString(`{"username":"lawrence","email":"lawrence@example.com","password":"some-passphrase"}`))
	rec := httptest.NewRecorder()
	h.CreateUser(rec, req)

	// Express byte-exact assertion: response must use `_id` (Mongo legacy),
	// not `id`.  We assert on the raw JSON to catch silent json tag drift.
	body := rec.Body.String()
	if !strings.Contains(body, `"_id":"11111111-1111-1111-1111-111111111111"`) {
		t.Errorf("response should contain `_id` field with the row UUID, got %s", body)
	}
	if strings.Contains(body, `"id":"`) {
		t.Errorf("response should NOT contain `id` field (Express uses `_id`), got %s", body)
	}
}

func TestCreateUser_MissingFields_400_ChineseExact(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		body string
	}{
		{"missing username", `{"email":"a@b.com","password":"pw"}`},
		{"missing email", `{"username":"x","password":"pw"}`},
		{"missing password", `{"username":"x","email":"a@b.com"}`},
		{"all empty", `{"username":"","email":"","password":""}`},
		{"empty body", `{}`},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			h := NewUserHandlers(&fakeUserDB{}, fakeEnqueuer{})
			req := httptest.NewRequest(http.MethodPost, "/api/admin/users",
				bytes.NewBufferString(tc.body))
			rec := httptest.NewRecorder()
			h.CreateUser(rec, req)
			assertErrorEnvelope(t, rec, http.StatusBadRequest, "BAD_REQUEST", "Username, email and password are required")
		})
	}
}

func TestCreateUser_DuplicateUsername_409_ChineseExact(t *testing.T) {
	t.Parallel()
	db := &fakeUserDB{
		adminFindFn: func(_ context.Context, _, _ *string) (dbgen.AdminFindUserByUsernameOrEmailRow, error) {
			return dbgen.AdminFindUserByUsernameOrEmailRow{
				ID:       uuid.New(),
				Username: "lawrence", // matches request → 用户名 conflict
				Email:    "other@example.com",
			}, nil
		},
	}
	h := NewUserHandlers(db, fakeEnqueuer{})

	req := httptest.NewRequest(http.MethodPost, "/api/admin/users",
		bytes.NewBufferString(`{"username":"lawrence","email":"lawrence@example.com","password":"pw"}`))
	rec := httptest.NewRecorder()
	h.CreateUser(rec, req)

	assertErrorEnvelope(t, rec, http.StatusConflict, "CONFLICT", "Username already exists")
}

func TestCreateUser_DuplicateEmail_409_ChineseExact(t *testing.T) {
	t.Parallel()
	db := &fakeUserDB{
		adminFindFn: func(_ context.Context, _, _ *string) (dbgen.AdminFindUserByUsernameOrEmailRow, error) {
			return dbgen.AdminFindUserByUsernameOrEmailRow{
				ID:       uuid.New(),
				Username: "someone-else", // does NOT match → 邮箱 conflict
				Email:    "lawrence@example.com",
			}, nil
		},
	}
	h := NewUserHandlers(db, fakeEnqueuer{})

	req := httptest.NewRequest(http.MethodPost, "/api/admin/users",
		bytes.NewBufferString(`{"username":"lawrence","email":"lawrence@example.com","password":"pw"}`))
	rec := httptest.NewRecorder()
	h.CreateUser(rec, req)

	assertErrorEnvelope(t, rec, http.StatusConflict, "CONFLICT", "Email already exists")
}

func TestCreateUser_UniqueViolationRace_409(t *testing.T) {
	t.Parallel()
	db := &fakeUserDB{
		adminFindFn: func(_ context.Context, _, _ *string) (dbgen.AdminFindUserByUsernameOrEmailRow, error) {
			// First call (pre-check): no dup.
			// Second call (race resolution): username matches → 用户名.
			return dbgen.AdminFindUserByUsernameOrEmailRow{}, pgx.ErrNoRows
		},
		adminCreateUserFn: func(_ context.Context, _, _, _ string) (dbgen.AdminCreateUserRow, error) {
			return dbgen.AdminCreateUserRow{}, &pgconn.PgError{Code: "23505"}
		},
	}
	// Override the second call to return the race winner.
	callCount := 0
	db.adminFindFn = func(_ context.Context, _, _ *string) (dbgen.AdminFindUserByUsernameOrEmailRow, error) {
		callCount++
		if callCount == 1 {
			return dbgen.AdminFindUserByUsernameOrEmailRow{}, pgx.ErrNoRows
		}
		return dbgen.AdminFindUserByUsernameOrEmailRow{
			ID:       uuid.New(),
			Username: "lawrence", // matches → 用户名 conflict
			Email:    "other@example.com",
		}, nil
	}
	h := NewUserHandlers(db, fakeEnqueuer{})

	req := httptest.NewRequest(http.MethodPost, "/api/admin/users",
		bytes.NewBufferString(`{"username":"lawrence","email":"lawrence@example.com","password":"pw"}`))
	rec := httptest.NewRecorder()
	h.CreateUser(rec, req)

	assertErrorEnvelope(t, rec, http.StatusConflict, "CONFLICT", "Username already exists")
}

func TestCreateUser_UniqueViolationRace_FallbackOnLookupFailure(t *testing.T) {
	t.Parallel()
	// Second lookup fails → fallback message must be the username conflict
	// (the conservative default documented in raceConflictMessage).
	callCount := 0
	db := &fakeUserDB{
		adminFindFn: func(_ context.Context, _, _ *string) (dbgen.AdminFindUserByUsernameOrEmailRow, error) {
			callCount++
			if callCount == 1 {
				return dbgen.AdminFindUserByUsernameOrEmailRow{}, pgx.ErrNoRows
			}
			return dbgen.AdminFindUserByUsernameOrEmailRow{}, errors.New("db gone away")
		},
		adminCreateUserFn: func(_ context.Context, _, _, _ string) (dbgen.AdminCreateUserRow, error) {
			return dbgen.AdminCreateUserRow{}, &pgconn.PgError{Code: "23505"}
		},
	}
	h := NewUserHandlers(db, fakeEnqueuer{})

	req := httptest.NewRequest(http.MethodPost, "/api/admin/users",
		bytes.NewBufferString(`{"username":"lawrence","email":"lawrence@example.com","password":"pw"}`))
	rec := httptest.NewRecorder()
	h.CreateUser(rec, req)
	assertErrorEnvelope(t, rec, http.StatusConflict, "CONFLICT", "Username already exists")
}

func TestCreateUser_PreCheckDBError_500(t *testing.T) {
	t.Parallel()
	db := &fakeUserDB{
		adminFindFn: func(_ context.Context, _, _ *string) (dbgen.AdminFindUserByUsernameOrEmailRow, error) {
			return dbgen.AdminFindUserByUsernameOrEmailRow{}, errors.New("connection refused")
		},
	}
	h := NewUserHandlers(db, fakeEnqueuer{})

	req := httptest.NewRequest(http.MethodPost, "/api/admin/users",
		bytes.NewBufferString(`{"username":"lawrence","email":"lawrence@example.com","password":"pw"}`))
	rec := httptest.NewRecorder()
	h.CreateUser(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500; body=%s", rec.Code, rec.Body.String())
	}
}

func TestCreateUser_InsertDBError_500(t *testing.T) {
	t.Parallel()
	db := &fakeUserDB{
		adminFindFn: func(_ context.Context, _, _ *string) (dbgen.AdminFindUserByUsernameOrEmailRow, error) {
			return dbgen.AdminFindUserByUsernameOrEmailRow{}, pgx.ErrNoRows
		},
		adminCreateUserFn: func(_ context.Context, _, _, _ string) (dbgen.AdminCreateUserRow, error) {
			return dbgen.AdminCreateUserRow{}, errors.New("disk full")
		},
	}
	h := NewUserHandlers(db, fakeEnqueuer{})

	req := httptest.NewRequest(http.MethodPost, "/api/admin/users",
		bytes.NewBufferString(`{"username":"lawrence","email":"lawrence@example.com","password":"pw"}`))
	rec := httptest.NewRecorder()
	h.CreateUser(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
}

func TestCreateUser_InvalidJSONBody_400(t *testing.T) {
	t.Parallel()
	h := NewUserHandlers(&fakeUserDB{}, fakeEnqueuer{})
	req := httptest.NewRequest(http.MethodPost, "/api/admin/users",
		bytes.NewBufferString(`{not-valid-json`))
	rec := httptest.NewRecorder()
	h.CreateUser(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestCreateUser_LogsAdminAction(t *testing.T) {
	t.Parallel()
	// Ensure ClaimsFrom path executes without panicking.  We don't
	// assert on slog output (slog captures are flaky across test
	// orderings); just verify the claims-present branch runs.
	want := fixtureCreateRow(t, "newbie", "newbie@example.com")
	db := &fakeUserDB{
		adminFindFn: func(_ context.Context, _, _ *string) (dbgen.AdminFindUserByUsernameOrEmailRow, error) {
			return dbgen.AdminFindUserByUsernameOrEmailRow{}, pgx.ErrNoRows
		},
		adminCreateUserFn: func(_ context.Context, _, _, _ string) (dbgen.AdminCreateUserRow, error) {
			return want, nil
		},
	}
	h := NewUserHandlers(db, fakeEnqueuer{})

	adminID := uuid.New()
	ctx := withAdminClaims(t, context.Background(), adminID, "admin-user")
	req := httptest.NewRequest(http.MethodPost, "/api/admin/users",
		bytes.NewBufferString(`{"username":"newbie","email":"newbie@example.com","password":"pw"}`)).WithContext(ctx)
	rec := httptest.NewRecorder()
	h.CreateUser(rec, req)

	if rec.Code != http.StatusCreated {
		t.Errorf("status = %d, want 201; body=%s", rec.Code, rec.Body.String())
	}
}

// -----------------------------------------------------------------------------
// UpdateUser
// -----------------------------------------------------------------------------

func TestUpdateUser_HappyPath_200(t *testing.T) {
	t.Parallel()
	id := uuid.MustParse("22222222-2222-2222-2222-222222222222")
	want := fixtureUpdateRow(t, id, "renamed", "renamed@example.com")
	db := &fakeUserDB{
		adminFindExcludingFn: func(_ context.Context, _, _ *string, _ uuid.UUID) (dbgen.AdminFindUserByUsernameOrEmailExcludingRow, error) {
			return dbgen.AdminFindUserByUsernameOrEmailExcludingRow{}, pgx.ErrNoRows
		},
		adminUpdateUserFn: func(_ context.Context, username, email *string, userID uuid.UUID) (dbgen.AdminUpdateUserRow, error) {
			if userID != id {
				t.Errorf("userID = %s, want %s", userID, id)
			}
			if username == nil || *username != "renamed" {
				t.Errorf("username pointer mismatch: %v", username)
			}
			if email == nil || *email != "renamed@example.com" {
				t.Errorf("email pointer mismatch: %v", email)
			}
			return want, nil
		},
	}
	h := NewUserHandlers(db, fakeEnqueuer{})

	req := requestWithUserID(t, http.MethodPatch, "/api/admin/users/"+id.String(),
		`{"username":"renamed","email":"renamed@example.com"}`, id.String())
	rec := httptest.NewRecorder()
	h.UpdateUser(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}

	body := rec.Body.String()
	if !strings.Contains(body, `"_id":"22222222-2222-2222-2222-222222222222"`) {
		t.Errorf("response missing _id field: %s", body)
	}
	if !strings.Contains(body, `"role":null`) {
		t.Errorf("response should emit role:null for nil role: %s", body)
	}
}

func TestUpdateUser_OnlyUsername_200(t *testing.T) {
	t.Parallel()
	id := uuid.New()
	want := fixtureUpdateRow(t, id, "newname", "original@example.com")
	db := &fakeUserDB{
		adminFindExcludingFn: func(_ context.Context, username, email *string, _ uuid.UUID) (dbgen.AdminFindUserByUsernameOrEmailExcludingRow, error) {
			if email != nil {
				t.Errorf("email pointer should be nil for username-only update, got %v", email)
			}
			if username == nil || *username != "newname" {
				t.Errorf("username = %v, want newname", username)
			}
			return dbgen.AdminFindUserByUsernameOrEmailExcludingRow{}, pgx.ErrNoRows
		},
		adminUpdateUserFn: func(_ context.Context, username, email *string, _ uuid.UUID) (dbgen.AdminUpdateUserRow, error) {
			if email != nil {
				t.Errorf("email pointer should be nil in COALESCE path")
			}
			return want, nil
		},
	}
	h := NewUserHandlers(db, fakeEnqueuer{})

	req := requestWithUserID(t, http.MethodPatch, "/api/admin/users/"+id.String(),
		`{"username":"newname"}`, id.String())
	rec := httptest.NewRecorder()
	h.UpdateUser(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
}

func TestUpdateUser_OnlyEmail_200(t *testing.T) {
	t.Parallel()
	id := uuid.New()
	want := fixtureUpdateRow(t, id, "original", "newaddr@example.com")
	db := &fakeUserDB{
		adminFindExcludingFn: func(_ context.Context, username, email *string, _ uuid.UUID) (dbgen.AdminFindUserByUsernameOrEmailExcludingRow, error) {
			if username != nil {
				t.Errorf("username pointer should be nil for email-only update, got %v", username)
			}
			return dbgen.AdminFindUserByUsernameOrEmailExcludingRow{}, pgx.ErrNoRows
		},
		adminUpdateUserFn: func(_ context.Context, username, _ *string, _ uuid.UUID) (dbgen.AdminUpdateUserRow, error) {
			if username != nil {
				t.Errorf("username pointer should be nil in COALESCE path")
			}
			return want, nil
		},
	}
	h := NewUserHandlers(db, fakeEnqueuer{})

	req := requestWithUserID(t, http.MethodPatch, "/api/admin/users/"+id.String(),
		`{"email":"newaddr@example.com"}`, id.String())
	rec := httptest.NewRecorder()
	h.UpdateUser(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
}

func TestUpdateUser_BothMissing_400_ChineseExact(t *testing.T) {
	t.Parallel()
	id := uuid.New()
	h := NewUserHandlers(&fakeUserDB{}, fakeEnqueuer{})
	cases := []string{
		`{}`,
		`{"username":""}`,
		`{"email":""}`,
		`{"username":"","email":""}`,
	}
	for _, body := range cases {
		body := body
		t.Run(body, func(t *testing.T) {
			t.Parallel()
			req := requestWithUserID(t, http.MethodPatch, "/api/admin/users/"+id.String(), body, id.String())
			rec := httptest.NewRecorder()
			h.UpdateUser(rec, req)
			assertErrorEnvelope(t, rec, http.StatusBadRequest, "BAD_REQUEST", "At least one of username or email is required")
		})
	}
}

func TestUpdateUser_InvalidUUID_400_ChineseExact(t *testing.T) {
	t.Parallel()
	h := NewUserHandlers(&fakeUserDB{}, fakeEnqueuer{})
	req := requestWithUserID(t, http.MethodPatch, "/api/admin/users/not-a-uuid",
		`{"username":"x"}`, "not-a-uuid")
	rec := httptest.NewRecorder()
	h.UpdateUser(rec, req)
	assertErrorEnvelope(t, rec, http.StatusBadRequest, "BAD_REQUEST", "Invalid user ID")
}

func TestUpdateUser_DuplicateUsername_409_ChineseExact(t *testing.T) {
	t.Parallel()
	id := uuid.New()
	db := &fakeUserDB{
		adminFindExcludingFn: func(_ context.Context, _, _ *string, _ uuid.UUID) (dbgen.AdminFindUserByUsernameOrEmailExcludingRow, error) {
			return dbgen.AdminFindUserByUsernameOrEmailExcludingRow{
				ID:       uuid.New(),
				Username: "taken-name",
				Email:    "other@example.com",
			}, nil
		},
	}
	h := NewUserHandlers(db, fakeEnqueuer{})

	req := requestWithUserID(t, http.MethodPatch, "/api/admin/users/"+id.String(),
		`{"username":"taken-name"}`, id.String())
	rec := httptest.NewRecorder()
	h.UpdateUser(rec, req)

	assertErrorEnvelope(t, rec, http.StatusConflict, "CONFLICT", "Username already exists")
}

func TestUpdateUser_DuplicateEmail_409_ChineseExact(t *testing.T) {
	t.Parallel()
	id := uuid.New()
	db := &fakeUserDB{
		adminFindExcludingFn: func(_ context.Context, _, _ *string, _ uuid.UUID) (dbgen.AdminFindUserByUsernameOrEmailExcludingRow, error) {
			return dbgen.AdminFindUserByUsernameOrEmailExcludingRow{
				ID:       uuid.New(),
				Username: "different-username",
				Email:    "taken@example.com",
			}, nil
		},
	}
	h := NewUserHandlers(db, fakeEnqueuer{})

	req := requestWithUserID(t, http.MethodPatch, "/api/admin/users/"+id.String(),
		`{"email":"taken@example.com"}`, id.String())
	rec := httptest.NewRecorder()
	h.UpdateUser(rec, req)

	assertErrorEnvelope(t, rec, http.StatusConflict, "CONFLICT", "Email already exists")
}

func TestUpdateUser_UserNotFound_404_ChineseExact(t *testing.T) {
	t.Parallel()
	id := uuid.New()
	db := &fakeUserDB{
		adminFindExcludingFn: func(_ context.Context, _, _ *string, _ uuid.UUID) (dbgen.AdminFindUserByUsernameOrEmailExcludingRow, error) {
			return dbgen.AdminFindUserByUsernameOrEmailExcludingRow{}, pgx.ErrNoRows
		},
		adminUpdateUserFn: func(_ context.Context, _, _ *string, _ uuid.UUID) (dbgen.AdminUpdateUserRow, error) {
			return dbgen.AdminUpdateUserRow{}, pgx.ErrNoRows
		},
	}
	h := NewUserHandlers(db, fakeEnqueuer{})

	req := requestWithUserID(t, http.MethodPatch, "/api/admin/users/"+id.String(),
		`{"username":"any"}`, id.String())
	rec := httptest.NewRecorder()
	h.UpdateUser(rec, req)

	assertErrorEnvelope(t, rec, http.StatusNotFound, "NOT_FOUND", "User not found")
}

func TestUpdateUser_InvalidJSONBody_400(t *testing.T) {
	t.Parallel()
	id := uuid.New()
	h := NewUserHandlers(&fakeUserDB{}, fakeEnqueuer{})
	req := requestWithUserID(t, http.MethodPatch, "/api/admin/users/"+id.String(),
		`{broken`, id.String())
	rec := httptest.NewRecorder()
	h.UpdateUser(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestUpdateUser_PreCheckDBError_500(t *testing.T) {
	t.Parallel()
	id := uuid.New()
	db := &fakeUserDB{
		adminFindExcludingFn: func(_ context.Context, _, _ *string, _ uuid.UUID) (dbgen.AdminFindUserByUsernameOrEmailExcludingRow, error) {
			return dbgen.AdminFindUserByUsernameOrEmailExcludingRow{}, errors.New("oh no")
		},
	}
	h := NewUserHandlers(db, fakeEnqueuer{})
	req := requestWithUserID(t, http.MethodPatch, "/api/admin/users/"+id.String(),
		`{"username":"x"}`, id.String())
	rec := httptest.NewRecorder()
	h.UpdateUser(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
}

func TestUpdateUser_UpdateDBError_500(t *testing.T) {
	t.Parallel()
	id := uuid.New()
	db := &fakeUserDB{
		adminFindExcludingFn: func(_ context.Context, _, _ *string, _ uuid.UUID) (dbgen.AdminFindUserByUsernameOrEmailExcludingRow, error) {
			return dbgen.AdminFindUserByUsernameOrEmailExcludingRow{}, pgx.ErrNoRows
		},
		adminUpdateUserFn: func(_ context.Context, _, _ *string, _ uuid.UUID) (dbgen.AdminUpdateUserRow, error) {
			return dbgen.AdminUpdateUserRow{}, errors.New("disk full")
		},
	}
	h := NewUserHandlers(db, fakeEnqueuer{})
	req := requestWithUserID(t, http.MethodPatch, "/api/admin/users/"+id.String(),
		`{"username":"x"}`, id.String())
	rec := httptest.NewRecorder()
	h.UpdateUser(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
}

func TestUpdateUser_UpdateUniqueViolation_409(t *testing.T) {
	t.Parallel()
	id := uuid.New()
	db := &fakeUserDB{
		adminFindExcludingFn: func(_ context.Context, _, _ *string, _ uuid.UUID) (dbgen.AdminFindUserByUsernameOrEmailExcludingRow, error) {
			// Pre-check clean; UPDATE catches the race.
			// Second call (race resolution) returns the conflict row.
			return dbgen.AdminFindUserByUsernameOrEmailExcludingRow{}, pgx.ErrNoRows
		},
		adminUpdateUserFn: func(_ context.Context, _, _ *string, _ uuid.UUID) (dbgen.AdminUpdateUserRow, error) {
			return dbgen.AdminUpdateUserRow{}, &pgconn.PgError{Code: "23505"}
		},
	}
	// Override the excluding find for race resolution:
	callCount := 0
	db.adminFindExcludingFn = func(_ context.Context, _, _ *string, _ uuid.UUID) (dbgen.AdminFindUserByUsernameOrEmailExcludingRow, error) {
		callCount++
		if callCount == 1 {
			return dbgen.AdminFindUserByUsernameOrEmailExcludingRow{}, pgx.ErrNoRows
		}
		return dbgen.AdminFindUserByUsernameOrEmailExcludingRow{
			ID:       uuid.New(),
			Username: "raced",
			Email:    "other@example.com",
		}, nil
	}
	h := NewUserHandlers(db, fakeEnqueuer{})
	req := requestWithUserID(t, http.MethodPatch, "/api/admin/users/"+id.String(),
		`{"username":"raced"}`, id.String())
	rec := httptest.NewRecorder()
	h.UpdateUser(rec, req)
	assertErrorEnvelope(t, rec, http.StatusConflict, "CONFLICT", "Username already exists")
}

// -----------------------------------------------------------------------------
// DeleteUser
// -----------------------------------------------------------------------------

func TestDeleteUser_HappyPath_200(t *testing.T) {
	t.Parallel()
	targetID := uuid.MustParse("33333333-3333-3333-3333-333333333333")
	user := fixtureDBUser(t, targetID, "victim")
	db := &fakeUserDB{
		getUserByIDFn: func(_ context.Context, id uuid.UUID) (dbgen.User, error) {
			if id != targetID {
				t.Errorf("id = %s, want %s", id, targetID)
			}
			return user, nil
		},
		adminDeleteUserFn: func(_ context.Context, _ uuid.UUID) error {
			return nil
		},
	}
	h := NewUserHandlers(db, fakeEnqueuer{})

	adminID := uuid.New()
	ctx := withAdminClaims(t, context.Background(), adminID, "admin")
	req := requestWithUserID(t, http.MethodDelete, "/api/admin/users/"+targetID.String(), "", targetID.String()).WithContext(
		// Preserve the chi route ctx + our claims.
		chiCtxOver(t, ctx, targetID.String()))
	rec := httptest.NewRecorder()
	h.DeleteUser(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}

	var got deleteUserResp
	decodeDataInto(t, rec.Body.Bytes(), &got)
	if !got.Deleted || got.Username != "victim" {
		t.Errorf("response = %+v, want {Deleted: true, Username: victim}", got)
	}

	if atomic.LoadInt32(&db.adminDeleteUserCallCount) != 1 {
		t.Errorf("AdminDeleteUser called %d times, want 1", db.adminDeleteUserCallCount)
	}
}

// chiCtxOver re-wraps an existing context with the chi route context
// containing the userId param.  Used by DeleteUser tests because we
// have both auth claims AND a URL param to inject.
func chiCtxOver(t *testing.T, baseCtx context.Context, userID string) context.Context {
	t.Helper()
	rc := chi.NewRouteContext()
	rc.URLParams.Add("userId", userID)
	return context.WithValue(baseCtx, chi.RouteCtxKey, rc)
}

func TestDeleteUser_SelfDelete_400_ChineseExact(t *testing.T) {
	t.Parallel()
	adminID := uuid.MustParse("44444444-4444-4444-4444-444444444444")
	db := &fakeUserDB{}
	h := NewUserHandlers(db, fakeEnqueuer{})

	ctx := withAdminClaims(t, context.Background(), adminID, "admin")
	req := requestWithUserID(t, http.MethodDelete, "/api/admin/users/"+adminID.String(), "", adminID.String()).WithContext(
		chiCtxOver(t, ctx, adminID.String()))
	rec := httptest.NewRecorder()
	h.DeleteUser(rec, req)

	assertErrorEnvelope(t, rec, http.StatusBadRequest, "BAD_REQUEST", "Cannot delete yourself")
	if atomic.LoadInt32(&db.adminDeleteUserCallCount) != 0 {
		t.Errorf("AdminDeleteUser called despite self-delete check, want 0 calls")
	}
}

func TestDeleteUser_UserNotFound_404_ChineseExact(t *testing.T) {
	t.Parallel()
	targetID := uuid.MustParse("55555555-5555-5555-5555-555555555555")
	db := &fakeUserDB{
		getUserByIDFn: func(_ context.Context, _ uuid.UUID) (dbgen.User, error) {
			return dbgen.User{}, pgx.ErrNoRows
		},
	}
	h := NewUserHandlers(db, fakeEnqueuer{})

	adminID := uuid.New()
	ctx := withAdminClaims(t, context.Background(), adminID, "admin")
	req := requestWithUserID(t, http.MethodDelete, "/api/admin/users/"+targetID.String(), "", targetID.String()).WithContext(
		chiCtxOver(t, ctx, targetID.String()))
	rec := httptest.NewRecorder()
	h.DeleteUser(rec, req)

	assertErrorEnvelope(t, rec, http.StatusNotFound, "NOT_FOUND", "User not found")
	if atomic.LoadInt32(&db.adminDeleteUserCallCount) != 0 {
		t.Errorf("AdminDeleteUser called despite missing user, want 0 calls")
	}
}

func TestDeleteUser_InvalidUUID_400_ChineseExact(t *testing.T) {
	t.Parallel()
	h := NewUserHandlers(&fakeUserDB{}, fakeEnqueuer{})
	adminID := uuid.New()
	ctx := withAdminClaims(t, context.Background(), adminID, "admin")
	req := requestWithUserID(t, http.MethodDelete, "/api/admin/users/garbage", "", "garbage").WithContext(
		chiCtxOver(t, ctx, "garbage"))
	rec := httptest.NewRecorder()
	h.DeleteUser(rec, req)
	assertErrorEnvelope(t, rec, http.StatusBadRequest, "BAD_REQUEST", "Invalid user ID")
}

func TestDeleteUser_MissingClaims_500(t *testing.T) {
	t.Parallel()
	// No claims in context — should surface 500 (routing bug), not 403.
	targetID := uuid.New()
	h := NewUserHandlers(&fakeUserDB{}, fakeEnqueuer{})
	req := requestWithUserID(t, http.MethodDelete, "/api/admin/users/"+targetID.String(), "", targetID.String())
	rec := httptest.NewRecorder()
	h.DeleteUser(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
}

func TestDeleteUser_GetUserDBError_500(t *testing.T) {
	t.Parallel()
	targetID := uuid.New()
	db := &fakeUserDB{
		getUserByIDFn: func(_ context.Context, _ uuid.UUID) (dbgen.User, error) {
			return dbgen.User{}, errors.New("db connection lost")
		},
	}
	h := NewUserHandlers(db, fakeEnqueuer{})
	adminID := uuid.New()
	ctx := withAdminClaims(t, context.Background(), adminID, "admin")
	req := requestWithUserID(t, http.MethodDelete, "/api/admin/users/"+targetID.String(), "", targetID.String()).WithContext(
		chiCtxOver(t, ctx, targetID.String()))
	rec := httptest.NewRecorder()
	h.DeleteUser(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
}

func TestDeleteUser_DeleteDBError_500(t *testing.T) {
	t.Parallel()
	targetID := uuid.New()
	db := &fakeUserDB{
		getUserByIDFn: func(_ context.Context, id uuid.UUID) (dbgen.User, error) {
			return fixtureDBUser(t, id, "victim"), nil
		},
		adminDeleteUserFn: func(_ context.Context, _ uuid.UUID) error {
			return errors.New("cascade failed")
		},
	}
	h := NewUserHandlers(db, fakeEnqueuer{})
	adminID := uuid.New()
	ctx := withAdminClaims(t, context.Background(), adminID, "admin")
	req := requestWithUserID(t, http.MethodDelete, "/api/admin/users/"+targetID.String(), "", targetID.String()).WithContext(
		chiCtxOver(t, ctx, targetID.String()))
	rec := httptest.NewRecorder()
	h.DeleteUser(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
}

// -----------------------------------------------------------------------------
// Constructor + helpers
// -----------------------------------------------------------------------------

func TestNewUserHandlers_NilDBPanics(t *testing.T) {
	t.Parallel()
	defer func() {
		if r := recover(); r == nil {
			t.Fatal("expected panic on nil UserDB")
		}
	}()
	_ = NewUserHandlers(nil, fakeEnqueuer{})
}

func TestNewUserHandlers_NilEnqueuerPanics(t *testing.T) {
	t.Parallel()
	defer func() {
		if r := recover(); r == nil {
			t.Fatal("expected panic on nil Enqueuer")
		}
	}()
	_ = NewUserHandlers(&fakeUserDB{}, nil)
}

func TestDupMessage_UsernameMatch(t *testing.T) {
	t.Parallel()
	if got := dupMessage("alice", "alice"); got != "Username already exists" {
		t.Errorf("dupMessage match = %q, want Username already exists", got)
	}
}

func TestDupMessage_NoMatch_DefaultsToEmail(t *testing.T) {
	t.Parallel()
	if got := dupMessage("alice", "bob"); got != "Email already exists" {
		t.Errorf("dupMessage no-match = %q, want Email already exists", got)
	}
}

func TestIsUniqueViolation_Code23505(t *testing.T) {
	t.Parallel()
	err := &pgconn.PgError{Code: "23505"}
	if !isUniqueViolation(err) {
		t.Errorf("isUniqueViolation(23505) = false, want true")
	}
}

func TestIsUniqueViolation_OtherCode(t *testing.T) {
	t.Parallel()
	err := &pgconn.PgError{Code: "23502"}
	if isUniqueViolation(err) {
		t.Errorf("isUniqueViolation(other) = true, want false")
	}
}

func TestIsUniqueViolation_NotPgError(t *testing.T) {
	t.Parallel()
	if isUniqueViolation(errors.New("plain error")) {
		t.Errorf("isUniqueViolation(plain) = true, want false")
	}
}

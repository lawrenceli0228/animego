package auth

// handlers_test.go — unit tests for the five auth handlers.  Tests
// substitute a fakeAuthDB (function-pointer fields) for the dbgen
// surface so no Postgres dependency is required.  A real jwtx.Signer
// with dummy secrets exercises the actual token-signing path —
// verifying token shape end-to-end matters more than mocking the
// signer.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	validatorPkg "github.com/go-playground/validator/v10"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/jwtx"
)

// pgconnPgError aliases the real pgconn.PgError so the error-path tests
// can build a real *pgconn.PgError value and isUniqueViolation's
// errors.As lookup matches the production type exactly.
type pgconnPgError = pgconn.PgError

// fakeAuthDB is a function-pointer mock matching the AuthDB interface.
// Per-test setup overrides the fields it cares about; unset fields
// panic if invoked so missing wiring is caught immediately.
type fakeAuthDB struct {
	createUser              func(ctx context.Context, username, email, password string) (dbgen.User, error)
	getUserByEmail          func(ctx context.Context, email string) (dbgen.User, error)
	getUserByUsername       func(ctx context.Context, username string) (dbgen.User, error)
	getUserByID             func(ctx context.Context, id uuid.UUID) (dbgen.User, error)
	updateUserRefreshToken  func(ctx context.Context, id uuid.UUID, refreshToken *string) error
	updateRefreshCalledWith *string
	updateRefreshCalledID   uuid.UUID
}

func (f *fakeAuthDB) CreateUser(ctx context.Context, username, email, password string) (dbgen.User, error) {
	if f.createUser == nil {
		panic("fakeAuthDB.CreateUser not set")
	}
	return f.createUser(ctx, username, email, password)
}
func (f *fakeAuthDB) GetUserByEmail(ctx context.Context, email string) (dbgen.User, error) {
	if f.getUserByEmail == nil {
		panic("fakeAuthDB.GetUserByEmail not set")
	}
	return f.getUserByEmail(ctx, email)
}
func (f *fakeAuthDB) GetUserByUsername(ctx context.Context, username string) (dbgen.User, error) {
	if f.getUserByUsername == nil {
		panic("fakeAuthDB.GetUserByUsername not set")
	}
	return f.getUserByUsername(ctx, username)
}
func (f *fakeAuthDB) GetUserByID(ctx context.Context, id uuid.UUID) (dbgen.User, error) {
	if f.getUserByID == nil {
		panic("fakeAuthDB.GetUserByID not set")
	}
	return f.getUserByID(ctx, id)
}
func (f *fakeAuthDB) UpdateUserRefreshToken(ctx context.Context, id uuid.UUID, refreshToken *string) error {
	f.updateRefreshCalledID = id
	if refreshToken != nil {
		v := *refreshToken
		f.updateRefreshCalledWith = &v
	} else {
		f.updateRefreshCalledWith = nil
	}
	if f.updateUserRefreshToken == nil {
		return nil
	}
	return f.updateUserRefreshToken(ctx, id, refreshToken)
}

// newTestSigner builds a real jwtx.Signer with dummy secrets and short
// TTLs.  Refresh TTL is intentionally longer than the access TTL but
// short enough that tests don't drift if run in CI under load.
func newTestSigner(t *testing.T) *jwtx.Signer {
	t.Helper()
	s, err := jwtx.NewSigner("test-access-secret", "test-refresh-secret", 15*time.Minute, 7*24*time.Hour)
	if err != nil {
		t.Fatalf("NewSigner: %v", err)
	}
	return s
}

// fixtureUser builds a fully populated dbgen.User for happy-path tests.
// password is pre-hashed for "correct-horse" so login can comparepw.
func fixtureUser(t *testing.T) dbgen.User {
	t.Helper()
	hash, err := jwtx.HashPassword("correct-horse")
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	id := uuid.MustParse("00000000-0000-0000-0000-000000000001")
	now := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	return dbgen.User{
		ID:        id,
		Username:  "lawrence",
		Email:     "lawrence@example.com",
		Password:  hash,
		Role:      nil,
		IsPublic:  true,
		CreatedAt: pgtype.Timestamptz{Time: now, Valid: true},
		UpdatedAt: pgtype.Timestamptz{Time: now, Valid: true},
	}
}

// decodeData JSON-decodes the {"data":...} envelope into the target.
func decodeData(t *testing.T, body []byte, target any) {
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

// assertError validates the 4xx envelope shape + message bytes.
func assertError(t *testing.T, rec *httptest.ResponseRecorder, wantStatus int, wantCode, wantMsg string) {
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
// Register
// -----------------------------------------------------------------------------

func TestRegister_HappyPath_201(t *testing.T) {
	t.Parallel()

	user := fixtureUser(t)
	db := &fakeAuthDB{
		getUserByEmail: func(ctx context.Context, email string) (dbgen.User, error) {
			return dbgen.User{}, pgx.ErrNoRows
		},
		getUserByUsername: func(ctx context.Context, username string) (dbgen.User, error) {
			return dbgen.User{}, pgx.ErrNoRows
		},
		createUser: func(ctx context.Context, username, email, password string) (dbgen.User, error) {
			// Echo the input with the populated fixture fields.
			out := user
			out.Username = username
			out.Email = email
			out.Password = password
			return out, nil
		},
	}
	h := NewHandlers(db, newTestSigner(t), 7*24*time.Hour, false)

	body := bytes.NewBufferString(`{"username":"lawrence","email":"new@example.com","password":"correct-horse"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/register", body)
	rec := httptest.NewRecorder()
	h.Register(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body=%s", rec.Code, rec.Body.String())
	}

	var data AuthData
	decodeData(t, rec.Body.Bytes(), &data)
	if data.AccessToken == "" {
		t.Error("accessToken missing in response")
	}
	if data.User.Username != "lawrence" || data.User.Email != "new@example.com" {
		t.Errorf("user payload mismatch: %+v", data.User)
	}

	if db.updateRefreshCalledWith == nil || *db.updateRefreshCalledWith == "" {
		t.Error("UpdateUserRefreshToken was not called with the new refresh token")
	}

	if c := getSetCookie(rec, RefreshCookieName); c == nil {
		t.Error("refreshToken cookie not set")
	}
}

func TestRegister_InvalidUsernameShort_400(t *testing.T) {
	t.Parallel()

	h := NewHandlers(&fakeAuthDB{}, newTestSigner(t), 7*24*time.Hour, false)
	body := bytes.NewBufferString(`{"username":"ab","email":"x@example.com","password":"correct-horse"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/register", body)
	rec := httptest.NewRecorder()
	h.Register(rec, req)

	assertError(t, rec, http.StatusBadRequest, "VALIDATION_ERROR", "用户名需 3-50 个字符")
}

func TestRegister_InvalidEmail_400(t *testing.T) {
	t.Parallel()

	h := NewHandlers(&fakeAuthDB{}, newTestSigner(t), 7*24*time.Hour, false)
	body := bytes.NewBufferString(`{"username":"lawrence","email":"not-an-email","password":"correct-horse"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/register", body)
	rec := httptest.NewRecorder()
	h.Register(rec, req)

	assertError(t, rec, http.StatusBadRequest, "VALIDATION_ERROR", "邮箱格式不正确")
}

func TestRegister_PasswordTooShort_400(t *testing.T) {
	t.Parallel()

	h := NewHandlers(&fakeAuthDB{}, newTestSigner(t), 7*24*time.Hour, false)
	body := bytes.NewBufferString(`{"username":"lawrence","email":"x@example.com","password":"12345"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/register", body)
	rec := httptest.NewRecorder()
	h.Register(rec, req)

	assertError(t, rec, http.StatusBadRequest, "VALIDATION_ERROR", "密码至少 6 位")
}

func TestRegister_DuplicateEmail_400(t *testing.T) {
	t.Parallel()

	user := fixtureUser(t)
	db := &fakeAuthDB{
		getUserByEmail: func(ctx context.Context, email string) (dbgen.User, error) {
			return user, nil
		},
		getUserByUsername: func(ctx context.Context, username string) (dbgen.User, error) {
			return dbgen.User{}, pgx.ErrNoRows
		},
	}
	h := NewHandlers(db, newTestSigner(t), 7*24*time.Hour, false)
	body := bytes.NewBufferString(`{"username":"lawrence","email":"taken@example.com","password":"correct-horse"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/register", body)
	rec := httptest.NewRecorder()
	h.Register(rec, req)

	assertError(t, rec, http.StatusBadRequest, "DUPLICATE_ERROR", "用户名或邮箱已存在")
}

func TestRegister_DuplicateUsername_400(t *testing.T) {
	t.Parallel()

	user := fixtureUser(t)
	db := &fakeAuthDB{
		getUserByEmail: func(ctx context.Context, email string) (dbgen.User, error) {
			return dbgen.User{}, pgx.ErrNoRows
		},
		getUserByUsername: func(ctx context.Context, username string) (dbgen.User, error) {
			return user, nil
		},
	}
	h := NewHandlers(db, newTestSigner(t), 7*24*time.Hour, false)
	body := bytes.NewBufferString(`{"username":"lawrence","email":"new@example.com","password":"correct-horse"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/register", body)
	rec := httptest.NewRecorder()
	h.Register(rec, req)

	assertError(t, rec, http.StatusBadRequest, "DUPLICATE_ERROR", "用户名或邮箱已存在")
}

func TestRegister_BadJSON_400(t *testing.T) {
	t.Parallel()

	h := NewHandlers(&fakeAuthDB{}, newTestSigner(t), 7*24*time.Hour, false)
	body := bytes.NewBufferString(`{not-json`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/register", body)
	rec := httptest.NewRecorder()
	h.Register(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

// -----------------------------------------------------------------------------
// Login
// -----------------------------------------------------------------------------

func TestLogin_HappyPath_200(t *testing.T) {
	t.Parallel()

	user := fixtureUser(t)
	db := &fakeAuthDB{
		getUserByEmail: func(ctx context.Context, email string) (dbgen.User, error) {
			return user, nil
		},
	}
	h := NewHandlers(db, newTestSigner(t), 7*24*time.Hour, false)

	body := bytes.NewBufferString(`{"email":"lawrence@example.com","password":"correct-horse"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", body)
	rec := httptest.NewRecorder()
	h.Login(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var data AuthData
	decodeData(t, rec.Body.Bytes(), &data)
	if data.AccessToken == "" {
		t.Error("accessToken missing")
	}
	if data.User.ID != user.ID {
		t.Errorf("user.ID = %s, want %s", data.User.ID, user.ID)
	}
	if c := getSetCookie(rec, RefreshCookieName); c == nil {
		t.Error("refreshToken cookie not set")
	}
}

func TestLogin_BadEmail_401(t *testing.T) {
	t.Parallel()

	db := &fakeAuthDB{
		getUserByEmail: func(ctx context.Context, email string) (dbgen.User, error) {
			return dbgen.User{}, pgx.ErrNoRows
		},
	}
	h := NewHandlers(db, newTestSigner(t), 7*24*time.Hour, false)

	body := bytes.NewBufferString(`{"email":"ghost@example.com","password":"whatever"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", body)
	rec := httptest.NewRecorder()
	h.Login(rec, req)

	assertError(t, rec, http.StatusUnauthorized, "INVALID_CREDENTIALS", "邮箱或密码错误")
}

func TestLogin_BadPassword_401(t *testing.T) {
	t.Parallel()

	user := fixtureUser(t)
	db := &fakeAuthDB{
		getUserByEmail: func(ctx context.Context, email string) (dbgen.User, error) {
			return user, nil
		},
	}
	h := NewHandlers(db, newTestSigner(t), 7*24*time.Hour, false)

	body := bytes.NewBufferString(`{"email":"lawrence@example.com","password":"wrong-pony"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", body)
	rec := httptest.NewRecorder()
	h.Login(rec, req)

	// Same message as bad-email — no enumeration.
	assertError(t, rec, http.StatusUnauthorized, "INVALID_CREDENTIALS", "邮箱或密码错误")
}

func TestLogin_MissingPassword_400(t *testing.T) {
	t.Parallel()

	h := NewHandlers(&fakeAuthDB{}, newTestSigner(t), 7*24*time.Hour, false)
	body := bytes.NewBufferString(`{"email":"lawrence@example.com","password":""}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", body)
	rec := httptest.NewRecorder()
	h.Login(rec, req)

	assertError(t, rec, http.StatusBadRequest, "VALIDATION_ERROR", "密码不能为空")
}

// -----------------------------------------------------------------------------
// Refresh
// -----------------------------------------------------------------------------

func TestRefresh_NoCookie_401_NoToken(t *testing.T) {
	t.Parallel()

	h := NewHandlers(&fakeAuthDB{}, newTestSigner(t), 7*24*time.Hour, false)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/refresh", nil)
	rec := httptest.NewRecorder()
	h.Refresh(rec, req)

	assertError(t, rec, http.StatusUnauthorized, "NO_TOKEN", "需要重新登录")
}

func TestRefresh_BadToken_401_InvalidToken(t *testing.T) {
	t.Parallel()

	h := NewHandlers(&fakeAuthDB{}, newTestSigner(t), 7*24*time.Hour, false)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/refresh", nil)
	req.AddCookie(&http.Cookie{Name: RefreshCookieName, Value: "not-a-jwt"})
	rec := httptest.NewRecorder()
	h.Refresh(rec, req)

	assertError(t, rec, http.StatusUnauthorized, "INVALID_TOKEN", "无效的 token")
}

func TestRefresh_DBTokenMismatch_401(t *testing.T) {
	t.Parallel()

	signer := newTestSigner(t)
	user := fixtureUser(t)
	// Sign a refresh token for the user but the DB row stores a
	// different one — the double-check fails.
	cookieToken, err := signer.SignRefresh(user.ID)
	if err != nil {
		t.Fatalf("SignRefresh: %v", err)
	}
	storedToken := "different-stored-refresh"
	user.RefreshToken = &storedToken

	db := &fakeAuthDB{
		getUserByID: func(ctx context.Context, id uuid.UUID) (dbgen.User, error) {
			return user, nil
		},
	}
	h := NewHandlers(db, signer, 7*24*time.Hour, false)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/refresh", nil)
	req.AddCookie(&http.Cookie{Name: RefreshCookieName, Value: cookieToken})
	rec := httptest.NewRecorder()
	h.Refresh(rec, req)

	assertError(t, rec, http.StatusUnauthorized, "INVALID_TOKEN", "无效的 token")
}

func TestRefresh_DBTokenNil_401(t *testing.T) {
	t.Parallel()

	signer := newTestSigner(t)
	user := fixtureUser(t)
	cookieToken, err := signer.SignRefresh(user.ID)
	if err != nil {
		t.Fatalf("SignRefresh: %v", err)
	}
	user.RefreshToken = nil

	db := &fakeAuthDB{
		getUserByID: func(ctx context.Context, id uuid.UUID) (dbgen.User, error) {
			return user, nil
		},
	}
	h := NewHandlers(db, signer, 7*24*time.Hour, false)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/refresh", nil)
	req.AddCookie(&http.Cookie{Name: RefreshCookieName, Value: cookieToken})
	rec := httptest.NewRecorder()
	h.Refresh(rec, req)

	assertError(t, rec, http.StatusUnauthorized, "INVALID_TOKEN", "无效的 token")
}

func TestRefresh_HappyPath_200(t *testing.T) {
	t.Parallel()

	signer := newTestSigner(t)
	user := fixtureUser(t)
	cookieToken, err := signer.SignRefresh(user.ID)
	if err != nil {
		t.Fatalf("SignRefresh: %v", err)
	}
	user.RefreshToken = &cookieToken

	db := &fakeAuthDB{
		getUserByID: func(ctx context.Context, id uuid.UUID) (dbgen.User, error) {
			return user, nil
		},
	}
	h := NewHandlers(db, signer, 7*24*time.Hour, false)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/refresh", nil)
	req.AddCookie(&http.Cookie{Name: RefreshCookieName, Value: cookieToken})
	rec := httptest.NewRecorder()
	h.Refresh(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var data RefreshData
	decodeData(t, rec.Body.Bytes(), &data)
	if data.AccessToken == "" {
		t.Error("accessToken missing in refresh response")
	}

	// New refresh cookie must be set (different from the old one in
	// most invocations; at minimum, present and non-empty).
	c := getSetCookie(rec, RefreshCookieName)
	if c == nil || c.Value == "" {
		t.Error("new refresh cookie not set on refresh response")
	}
}

// -----------------------------------------------------------------------------
// Logout
// -----------------------------------------------------------------------------

func TestLogout_ClearsDBAndCookie(t *testing.T) {
	t.Parallel()

	user := fixtureUser(t)
	db := &fakeAuthDB{
		updateUserRefreshToken: func(ctx context.Context, id uuid.UUID, refreshToken *string) error {
			return nil
		},
	}
	h := NewHandlers(db, newTestSigner(t), 7*24*time.Hour, false)

	req := httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	req = req.WithContext(injectClaims(req.Context(), user.ID, user.Username, user.Role))
	rec := httptest.NewRecorder()
	h.Logout(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}

	// DB-side: UpdateUserRefreshToken called with nil.
	if db.updateRefreshCalledWith != nil {
		t.Errorf("UpdateUserRefreshToken refresh = %v, want nil", *db.updateRefreshCalledWith)
	}
	if db.updateRefreshCalledID != user.ID {
		t.Errorf("UpdateUserRefreshToken id = %s, want %s", db.updateRefreshCalledID, user.ID)
	}

	// Cookie-side: Set-Cookie has MaxAge<=0.
	c := getSetCookie(rec, RefreshCookieName)
	if c == nil {
		t.Fatal("no refreshToken cookie cleared")
	}
	if c.MaxAge > 0 {
		t.Errorf("MaxAge = %d, want <= 0", c.MaxAge)
	}

	// Body: {"data":{"message":"已登出"}}
	var data MessageData
	decodeData(t, rec.Body.Bytes(), &data)
	if data.Message != "已登出" {
		t.Errorf("message = %q, want 已登出", data.Message)
	}
}

// -----------------------------------------------------------------------------
// Me
// -----------------------------------------------------------------------------

func TestMe_HappyPath(t *testing.T) {
	t.Parallel()

	user := fixtureUser(t)
	db := &fakeAuthDB{
		getUserByID: func(ctx context.Context, id uuid.UUID) (dbgen.User, error) {
			return user, nil
		},
	}
	h := NewHandlers(db, newTestSigner(t), 7*24*time.Hour, false)

	req := httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
	req = req.WithContext(injectClaims(req.Context(), user.ID, user.Username, user.Role))
	rec := httptest.NewRecorder()
	h.Me(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var data MeData
	decodeData(t, rec.Body.Bytes(), &data)
	if data.User.ID != user.ID {
		t.Errorf("user.ID = %s, want %s", data.User.ID, user.ID)
	}
	if data.User.Username != user.Username {
		t.Errorf("user.Username = %s, want %s", data.User.Username, user.Username)
	}
}

func TestMe_UserDeleted_404(t *testing.T) {
	t.Parallel()

	user := fixtureUser(t)
	db := &fakeAuthDB{
		getUserByID: func(ctx context.Context, id uuid.UUID) (dbgen.User, error) {
			return dbgen.User{}, pgx.ErrNoRows
		},
	}
	h := NewHandlers(db, newTestSigner(t), 7*24*time.Hour, false)

	req := httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
	req = req.WithContext(injectClaims(req.Context(), user.ID, user.Username, user.Role))
	rec := httptest.NewRecorder()
	h.Me(rec, req)

	assertError(t, rec, http.StatusNotFound, "NOT_FOUND", "用户不存在")
}

func TestMe_NoClaims_500(t *testing.T) {
	t.Parallel()

	h := NewHandlers(&fakeAuthDB{}, newTestSigner(t), 7*24*time.Hour, false)
	req := httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
	rec := httptest.NewRecorder()
	h.Me(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
}

// -----------------------------------------------------------------------------
// SafeUser projection
// -----------------------------------------------------------------------------

func TestSafeUser_StripsSensitiveFields(t *testing.T) {
	t.Parallel()

	secret := "stored-refresh-token"
	resetTok := "reset-tok-value"
	user := fixtureUser(t)
	user.Password = "BCRYPT-SECRET-HASH-DO-NOT-LEAK"
	user.RefreshToken = &secret
	user.ResetPasswordToken = &resetTok

	safe := ToSafeUser(user)
	out, err := json.Marshal(safe)
	if err != nil {
		t.Fatalf("marshal SafeUser: %v", err)
	}
	body := string(out)

	for _, banned := range []string{"password", "BCRYPT-SECRET-HASH-DO-NOT-LEAK", "refreshToken", "stored-refresh-token", "resetPasswordToken", "reset-tok-value"} {
		if strings.Contains(body, banned) {
			t.Errorf("SafeUser leaked sensitive field %q: %s", banned, body)
		}
	}

	// Required fields ARE present.
	for _, want := range []string{"id", "username", "email", "role", "isPublic", "createdAt", "updatedAt"} {
		if !strings.Contains(body, `"`+want+`"`) {
			t.Errorf("SafeUser missing field %q: %s", want, body)
		}
	}
}

func TestToSafeUser_PreservesIsPublicAndRole(t *testing.T) {
	t.Parallel()

	role := "admin"
	user := fixtureUser(t)
	user.IsPublic = false
	user.Role = &role

	safe := ToSafeUser(user)
	if safe.IsPublic {
		t.Error("IsPublic not preserved (got true, want false)")
	}
	if safe.Role == nil || *safe.Role != "admin" {
		t.Errorf("Role = %v, want admin", safe.Role)
	}
}

// -----------------------------------------------------------------------------
// Helpers (test-only)
// -----------------------------------------------------------------------------

// injectClaims puts AccessClaims into a context exactly the way
// jwtx.RequireAuth would.  We can't reach the unexported jwtx withClaims
// directly, so we round-trip a signed token through VerifyAccess + a
// fake request — too heavy for unit tests.  Instead, we sign an access
// token and call signer.VerifyAccess from a wrapper handler in tests
// that need the chain.  For pure handler-unit tests, we use the
// jwtx middleware-equivalent path via a helper.
//
// Implementation choice: build a tiny middleware that signs + verifies
// to get a real claims value into ctx, then unwrap.  This keeps the
// auth/handlers tests aligned with how the production wiring works.
func injectClaims(ctx context.Context, userID uuid.UUID, username string, role *string) context.Context {
	signer, _ := jwtx.NewSigner("test-access-secret", "test-refresh-secret", 15*time.Minute, time.Hour)
	tok, _ := signer.SignAccess(userID, username, role)

	// Spin up a no-op handler behind RequireAuth so jwtx can populate
	// the context with claims using its own internal API.
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
		// Fall back: build the ctx without claims (the test will fail
		// loudly downstream if it relies on them).
		return ctx
	}
	return captured
}

// getSetCookie scans the response's Set-Cookie headers for a cookie of
// the given name and returns the parsed *http.Cookie or nil.
func getSetCookie(rec *httptest.ResponseRecorder, name string) *http.Cookie {
	// http.Response wraps the recorder's headers into a parser-friendly form.
	resp := http.Response{Header: rec.Result().Header}
	for _, c := range resp.Cookies() {
		if c.Name == name {
			return c
		}
	}
	return nil
}

// -----------------------------------------------------------------------------
// Error-path coverage: DB failures + unique-violation race
// -----------------------------------------------------------------------------

// fakePgError implements the *pgconn.PgError shape just enough for
// errors.As + Code lookup.  We use the real pgconn type for honesty.

func TestIsUniqueViolation_True(t *testing.T) {
	t.Parallel()
	err := &pgconnPgError{Code: "23505"}
	if !isUniqueViolation(err) {
		t.Errorf("isUniqueViolation(23505) = false, want true")
	}
}

func TestIsUniqueViolation_OtherCode(t *testing.T) {
	t.Parallel()
	err := &pgconnPgError{Code: "23502"} // not-null violation
	if isUniqueViolation(err) {
		t.Errorf("isUniqueViolation(23502) = true, want false")
	}
}

func TestIsUniqueViolation_NotPgError(t *testing.T) {
	t.Parallel()
	if isUniqueViolation(errors.New("plain error")) {
		t.Errorf("isUniqueViolation(plain err) = true, want false")
	}
}

func TestRegister_RaceUniqueViolation_400(t *testing.T) {
	t.Parallel()

	db := &fakeAuthDB{
		getUserByEmail: func(ctx context.Context, email string) (dbgen.User, error) {
			return dbgen.User{}, pgx.ErrNoRows
		},
		getUserByUsername: func(ctx context.Context, username string) (dbgen.User, error) {
			return dbgen.User{}, pgx.ErrNoRows
		},
		createUser: func(ctx context.Context, username, email, password string) (dbgen.User, error) {
			return dbgen.User{}, &pgconnPgError{Code: "23505"}
		},
	}
	h := NewHandlers(db, newTestSigner(t), 7*24*time.Hour, false)
	body := bytes.NewBufferString(`{"username":"lawrence","email":"x@example.com","password":"correct-horse"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/register", body)
	rec := httptest.NewRecorder()
	h.Register(rec, req)

	assertError(t, rec, http.StatusBadRequest, "DUPLICATE_ERROR", "用户名或邮箱已存在")
}

func TestRegister_CreateUserGenericError_500(t *testing.T) {
	t.Parallel()

	db := &fakeAuthDB{
		getUserByEmail: func(ctx context.Context, email string) (dbgen.User, error) {
			return dbgen.User{}, pgx.ErrNoRows
		},
		getUserByUsername: func(ctx context.Context, username string) (dbgen.User, error) {
			return dbgen.User{}, pgx.ErrNoRows
		},
		createUser: func(ctx context.Context, username, email, password string) (dbgen.User, error) {
			return dbgen.User{}, errors.New("connection refused")
		},
	}
	h := NewHandlers(db, newTestSigner(t), 7*24*time.Hour, false)
	body := bytes.NewBufferString(`{"username":"lawrence","email":"x@example.com","password":"correct-horse"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/register", body)
	rec := httptest.NewRecorder()
	h.Register(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
}

func TestRegister_DuplicateCheckDBError_500(t *testing.T) {
	t.Parallel()

	db := &fakeAuthDB{
		getUserByEmail: func(ctx context.Context, email string) (dbgen.User, error) {
			return dbgen.User{}, errors.New("db down")
		},
		getUserByUsername: func(ctx context.Context, username string) (dbgen.User, error) {
			return dbgen.User{}, pgx.ErrNoRows
		},
	}
	h := NewHandlers(db, newTestSigner(t), 7*24*time.Hour, false)
	body := bytes.NewBufferString(`{"username":"lawrence","email":"x@example.com","password":"correct-horse"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/register", body)
	rec := httptest.NewRecorder()
	h.Register(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
}

func TestLogin_DBError_500(t *testing.T) {
	t.Parallel()

	db := &fakeAuthDB{
		getUserByEmail: func(ctx context.Context, email string) (dbgen.User, error) {
			return dbgen.User{}, errors.New("db down")
		},
	}
	h := NewHandlers(db, newTestSigner(t), 7*24*time.Hour, false)
	body := bytes.NewBufferString(`{"email":"x@example.com","password":"correct-horse"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", body)
	rec := httptest.NewRecorder()
	h.Login(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
}

func TestLogin_BadJSON_400(t *testing.T) {
	t.Parallel()

	h := NewHandlers(&fakeAuthDB{}, newTestSigner(t), 7*24*time.Hour, false)
	body := bytes.NewBufferString(`{ malformed`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", body)
	rec := httptest.NewRecorder()
	h.Login(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestRefresh_UserNotFound_401(t *testing.T) {
	t.Parallel()

	signer := newTestSigner(t)
	user := fixtureUser(t)
	cookieToken, err := signer.SignRefresh(user.ID)
	if err != nil {
		t.Fatalf("SignRefresh: %v", err)
	}

	db := &fakeAuthDB{
		getUserByID: func(ctx context.Context, id uuid.UUID) (dbgen.User, error) {
			return dbgen.User{}, pgx.ErrNoRows
		},
	}
	h := NewHandlers(db, signer, 7*24*time.Hour, false)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/refresh", nil)
	req.AddCookie(&http.Cookie{Name: RefreshCookieName, Value: cookieToken})
	rec := httptest.NewRecorder()
	h.Refresh(rec, req)

	assertError(t, rec, http.StatusUnauthorized, "INVALID_TOKEN", "无效的 token")
}

func TestLogout_NoClaims_500(t *testing.T) {
	t.Parallel()

	h := NewHandlers(&fakeAuthDB{}, newTestSigner(t), 7*24*time.Hour, false)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	rec := httptest.NewRecorder()
	h.Logout(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
}

func TestValidationMessage_UnknownField_Generic(t *testing.T) {
	t.Parallel()
	// Validate an arbitrary struct whose field isn't in our map.
	type Unknown struct {
		Anything string `validate:"required"`
	}
	v := validatorPkg.New(validatorPkg.WithRequiredStructEnabled())
	err := v.Struct(&Unknown{})
	msg := validationMessage(err)
	if msg != "参数错误" {
		t.Errorf("validationMessage = %q, want generic %q", msg, "参数错误")
	}
}

func TestValidationMessage_NonValidatorError(t *testing.T) {
	t.Parallel()
	msg := validationMessage(errors.New("not a validator error"))
	if msg != "参数错误" {
		t.Errorf("validationMessage = %q, want generic", msg)
	}
}

func TestSetClearRefreshCookie_ProdMode(t *testing.T) {
	t.Parallel()

	rec := httptest.NewRecorder()
	SetRefreshCookie(rec, "tok", time.Hour, true)
	c := getSetCookie(rec, RefreshCookieName)
	if c == nil {
		t.Fatal("cookie not set")
	}
	if !c.Secure {
		t.Error("Secure not set in prod mode")
	}
	if c.SameSite != http.SameSiteNoneMode {
		t.Errorf("SameSite = %v, want None in prod", c.SameSite)
	}

	rec2 := httptest.NewRecorder()
	ClearRefreshCookie(rec2, true)
	cc := getSetCookie(rec2, RefreshCookieName)
	if cc == nil {
		t.Fatal("cleared cookie not set")
	}
	if cc.MaxAge >= 0 {
		t.Errorf("MaxAge = %d, want negative (cleared)", cc.MaxAge)
	}
}

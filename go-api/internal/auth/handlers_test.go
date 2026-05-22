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
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
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

	// Password-reset trio (P2.2.1).  Each Fn is optional — unset Fn
	// panics on invocation so a test that forgets to wire one fails
	// loudly rather than silently no-oping.  Call-capture fields below
	// let tests assert exactly what landed in the DB without per-test
	// boilerplate.
	setResetPasswordTokenFn func(ctx context.Context, id uuid.UUID, token *string, expires pgtype.Timestamptz) error
	getUserByResetTokenFn   func(ctx context.Context, token *string) (dbgen.User, error)
	resetUserPasswordFn     func(ctx context.Context, id uuid.UUID, password string) error

	setResetTokenCalledID      uuid.UUID
	setResetTokenCalledToken   *string
	setResetTokenCalledExpires pgtype.Timestamptz
	setResetTokenCallCount     int

	resetPasswordCalledID       uuid.UUID
	resetPasswordCalledPassword string
	resetPasswordCallCount      int
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

// SetResetPasswordToken captures the (id, token, expires) tuple AND
// delegates to setResetPasswordTokenFn if set.  Tests that don't care
// about the return value can leave the Fn nil — the call is still
// recorded so absence-of-call tests (e.g. unknown-email) can assert
// `setResetTokenCallCount == 0`.
func (f *fakeAuthDB) SetResetPasswordToken(ctx context.Context, id uuid.UUID, token *string, expires pgtype.Timestamptz) error {
	f.setResetTokenCalledID = id
	if token != nil {
		v := *token
		f.setResetTokenCalledToken = &v
	} else {
		f.setResetTokenCalledToken = nil
	}
	f.setResetTokenCalledExpires = expires
	f.setResetTokenCallCount++
	if f.setResetPasswordTokenFn == nil {
		return nil
	}
	return f.setResetPasswordTokenFn(ctx, id, token, expires)
}

func (f *fakeAuthDB) GetUserByResetToken(ctx context.Context, token *string) (dbgen.User, error) {
	if f.getUserByResetTokenFn == nil {
		panic("fakeAuthDB.GetUserByResetToken not set")
	}
	return f.getUserByResetTokenFn(ctx, token)
}

// ResetUserPassword captures (id, password) AND delegates to
// resetUserPasswordFn if set.  Capturing the password lets tests
// verify the bcrypt hash that landed in storage (round-trip via
// jwtx.ComparePassword).
func (f *fakeAuthDB) ResetUserPassword(ctx context.Context, id uuid.UUID, password string) error {
	f.resetPasswordCalledID = id
	f.resetPasswordCalledPassword = password
	f.resetPasswordCallCount++
	if f.resetUserPasswordFn == nil {
		return nil
	}
	return f.resetUserPasswordFn(ctx, id, password)
}

// fakeEmailCall records a single SendPasswordReset invocation.
type fakeEmailCall struct {
	to       string
	resetURL string
}

// fakeEmailSender is an in-package email.Sender stub.  Captures every
// SendPasswordReset call so tests can assert recipient + URL shape; the
// `err` field forces a particular send-failure return.
type fakeEmailSender struct {
	calls []fakeEmailCall
	err   error
}

func (f *fakeEmailSender) SendPasswordReset(_ context.Context, to, resetURL string) error {
	f.calls = append(f.calls, fakeEmailCall{to: to, resetURL: resetURL})
	return f.err
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
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 7*24*time.Hour, false)

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

	h := NewHandlers(&fakeAuthDB{}, newTestSigner(t), nil, "http://localhost:3000", 7*24*time.Hour, false)
	body := bytes.NewBufferString(`{"username":"ab","email":"x@example.com","password":"correct-horse"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/register", body)
	rec := httptest.NewRecorder()
	h.Register(rec, req)

	assertError(t, rec, http.StatusBadRequest, "VALIDATION_ERROR", "用户名需 3-50 个字符")
}

func TestRegister_InvalidEmail_400(t *testing.T) {
	t.Parallel()

	h := NewHandlers(&fakeAuthDB{}, newTestSigner(t), nil, "http://localhost:3000", 7*24*time.Hour, false)
	body := bytes.NewBufferString(`{"username":"lawrence","email":"not-an-email","password":"correct-horse"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/register", body)
	rec := httptest.NewRecorder()
	h.Register(rec, req)

	assertError(t, rec, http.StatusBadRequest, "VALIDATION_ERROR", "邮箱格式不正确")
}

func TestRegister_PasswordTooShort_400(t *testing.T) {
	t.Parallel()

	h := NewHandlers(&fakeAuthDB{}, newTestSigner(t), nil, "http://localhost:3000", 7*24*time.Hour, false)
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
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 7*24*time.Hour, false)
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
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 7*24*time.Hour, false)
	body := bytes.NewBufferString(`{"username":"lawrence","email":"new@example.com","password":"correct-horse"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/register", body)
	rec := httptest.NewRecorder()
	h.Register(rec, req)

	assertError(t, rec, http.StatusBadRequest, "DUPLICATE_ERROR", "用户名或邮箱已存在")
}

func TestRegister_BadJSON_400(t *testing.T) {
	t.Parallel()

	h := NewHandlers(&fakeAuthDB{}, newTestSigner(t), nil, "http://localhost:3000", 7*24*time.Hour, false)
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
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 7*24*time.Hour, false)

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
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 7*24*time.Hour, false)

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
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 7*24*time.Hour, false)

	body := bytes.NewBufferString(`{"email":"lawrence@example.com","password":"wrong-pony"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", body)
	rec := httptest.NewRecorder()
	h.Login(rec, req)

	// Same message as bad-email — no enumeration.
	assertError(t, rec, http.StatusUnauthorized, "INVALID_CREDENTIALS", "邮箱或密码错误")
}

func TestLogin_MissingPassword_400(t *testing.T) {
	t.Parallel()

	h := NewHandlers(&fakeAuthDB{}, newTestSigner(t), nil, "http://localhost:3000", 7*24*time.Hour, false)
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

	h := NewHandlers(&fakeAuthDB{}, newTestSigner(t), nil, "http://localhost:3000", 7*24*time.Hour, false)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/refresh", nil)
	rec := httptest.NewRecorder()
	h.Refresh(rec, req)

	assertError(t, rec, http.StatusUnauthorized, "NO_TOKEN", "需要重新登录")
}

func TestRefresh_BadToken_401_InvalidToken(t *testing.T) {
	t.Parallel()

	h := NewHandlers(&fakeAuthDB{}, newTestSigner(t), nil, "http://localhost:3000", 7*24*time.Hour, false)
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
	h := NewHandlers(db, signer, nil, "http://localhost:3000", 7*24*time.Hour, false)
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
	h := NewHandlers(db, signer, nil, "http://localhost:3000", 7*24*time.Hour, false)
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
	h := NewHandlers(db, signer, nil, "http://localhost:3000", 7*24*time.Hour, false)
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
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 7*24*time.Hour, false)

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
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 7*24*time.Hour, false)

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
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 7*24*time.Hour, false)

	req := httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
	req = req.WithContext(injectClaims(req.Context(), user.ID, user.Username, user.Role))
	rec := httptest.NewRecorder()
	h.Me(rec, req)

	assertError(t, rec, http.StatusNotFound, "NOT_FOUND", "用户不存在")
}

func TestMe_NoClaims_500(t *testing.T) {
	t.Parallel()

	h := NewHandlers(&fakeAuthDB{}, newTestSigner(t), nil, "http://localhost:3000", 7*24*time.Hour, false)
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
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 7*24*time.Hour, false)
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
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 7*24*time.Hour, false)
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
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 7*24*time.Hour, false)
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
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 7*24*time.Hour, false)
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

	h := NewHandlers(&fakeAuthDB{}, newTestSigner(t), nil, "http://localhost:3000", 7*24*time.Hour, false)
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
	h := NewHandlers(db, signer, nil, "http://localhost:3000", 7*24*time.Hour, false)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/refresh", nil)
	req.AddCookie(&http.Cookie{Name: RefreshCookieName, Value: cookieToken})
	rec := httptest.NewRecorder()
	h.Refresh(rec, req)

	assertError(t, rec, http.StatusUnauthorized, "INVALID_TOKEN", "无效的 token")
}

func TestLogout_NoClaims_500(t *testing.T) {
	t.Parallel()

	h := NewHandlers(&fakeAuthDB{}, newTestSigner(t), nil, "http://localhost:3000", 7*24*time.Hour, false)
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

// -----------------------------------------------------------------------------
// ForgotPassword (P2.2.1)
// -----------------------------------------------------------------------------
//
// The forgot-password contract is "always 200, same message" so most of
// the tests below assert behaviour-around-the-200 rather than the
// status code:  was the token persisted? was the email sent? did the
// not-found path skip both side effects?

// hex64Pattern matches the 32-byte hex token shape emitted by
// crypto/rand → hex.EncodeToString.  Used by tests that capture the
// reset URL and assert it ends with a valid token.
var hex64Pattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// extractTokenFromResetURL pulls the suffix after the last "/" from a
// reset URL.  Tests use this to verify the token shape captured by the
// fakeEmailSender.
func extractTokenFromResetURL(t *testing.T, resetURL string) string {
	t.Helper()
	idx := strings.LastIndex(resetURL, "/")
	if idx == -1 || idx+1 >= len(resetURL) {
		t.Fatalf("reset URL has no token suffix: %s", resetURL)
	}
	return resetURL[idx+1:]
}

// newForgotPasswordHandler is a tiny constructor used by every
// ForgotPassword test — wires the fake db + email sender + a known
// client origin so the reset URL is deterministic.
func newForgotPasswordHandler(t *testing.T, db AuthDB, sender *fakeEmailSender, clientOrigin string) *Handlers {
	t.Helper()
	return NewHandlers(db, newTestSigner(t), sender, clientOrigin, 7*24*time.Hour, false)
}

func TestForgotPassword_HappyPath_UserExists(t *testing.T) {
	t.Parallel()

	user := fixtureUser(t)
	db := &fakeAuthDB{
		getUserByEmail: func(ctx context.Context, email string) (dbgen.User, error) {
			return user, nil
		},
	}
	sender := &fakeEmailSender{}
	h := newForgotPasswordHandler(t, db, sender, "http://localhost:3000")

	before := time.Now()
	body := bytes.NewBufferString(`{"email":"lawrence@example.com"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/forgot-password", body)
	rec := httptest.NewRecorder()
	h.ForgotPassword(rec, req)
	after := time.Now()

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	// Byte-exact envelope including the generic message.
	wantBody := `{"data":{"message":"如果该邮箱已注册，你将收到重置链接"}}`
	if got := rec.Body.String(); got != wantBody {
		t.Errorf("body mismatch\n got: %s\nwant: %s", got, wantBody)
	}

	if db.setResetTokenCallCount != 1 {
		t.Fatalf("SetResetPasswordToken call count = %d, want 1", db.setResetTokenCallCount)
	}
	if db.setResetTokenCalledID != user.ID {
		t.Errorf("SetResetPasswordToken id = %s, want %s", db.setResetTokenCalledID, user.ID)
	}
	if db.setResetTokenCalledToken == nil || !hex64Pattern.MatchString(*db.setResetTokenCalledToken) {
		t.Errorf("token shape = %v, want 64-char hex", db.setResetTokenCalledToken)
	}
	// Expiry is now+~1h.  Allow a small drift for the time.Now() reads.
	if !db.setResetTokenCalledExpires.Valid {
		t.Fatal("expires Valid = false")
	}
	gotExpiresIn := db.setResetTokenCalledExpires.Time.Sub(before)
	maxExpiresIn := after.Add(time.Hour + 5*time.Second).Sub(before)
	if gotExpiresIn < time.Hour-time.Second {
		t.Errorf("expires offset = %s, want >= 1h", gotExpiresIn)
	}
	if gotExpiresIn > maxExpiresIn {
		t.Errorf("expires offset = %s, want <= 1h + drift", gotExpiresIn)
	}

	if len(sender.calls) != 1 {
		t.Fatalf("sender call count = %d, want 1", len(sender.calls))
	}
	if sender.calls[0].to != user.Email {
		t.Errorf("sender to = %q, want %q", sender.calls[0].to, user.Email)
	}
	if !strings.HasPrefix(sender.calls[0].resetURL, "http://localhost:3000/reset-password/") {
		t.Errorf("resetURL prefix mismatch: %s", sender.calls[0].resetURL)
	}
}

func TestForgotPassword_UnknownEmail_StillReturns200(t *testing.T) {
	t.Parallel()

	db := &fakeAuthDB{
		getUserByEmail: func(ctx context.Context, email string) (dbgen.User, error) {
			return dbgen.User{}, pgx.ErrNoRows
		},
	}
	sender := &fakeEmailSender{}
	h := newForgotPasswordHandler(t, db, sender, "http://localhost:3000")

	body := bytes.NewBufferString(`{"email":"ghost@example.com"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/forgot-password", body)
	rec := httptest.NewRecorder()
	h.ForgotPassword(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	wantBody := `{"data":{"message":"如果该邮箱已注册，你将收到重置链接"}}`
	if got := rec.Body.String(); got != wantBody {
		t.Errorf("body mismatch\n got: %s\nwant: %s", got, wantBody)
	}

	// No side effects on the unknown-email path.
	if db.setResetTokenCallCount != 0 {
		t.Errorf("SetResetPasswordToken called %d times, want 0", db.setResetTokenCallCount)
	}
	if len(sender.calls) != 0 {
		t.Errorf("sender invoked %d times, want 0", len(sender.calls))
	}
}

func TestForgotPassword_InvalidEmail_400(t *testing.T) {
	t.Parallel()

	db := &fakeAuthDB{}
	sender := &fakeEmailSender{}
	h := newForgotPasswordHandler(t, db, sender, "http://localhost:3000")

	body := bytes.NewBufferString(`{"email":"not-an-email"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/forgot-password", body)
	rec := httptest.NewRecorder()
	h.ForgotPassword(rec, req)

	assertError(t, rec, http.StatusBadRequest, "VALIDATION_ERROR", "邮箱格式不正确")
	if db.setResetTokenCallCount != 0 {
		t.Errorf("SetResetPasswordToken called %d times on invalid email, want 0", db.setResetTokenCallCount)
	}
	if len(sender.calls) != 0 {
		t.Errorf("sender invoked %d times on invalid email, want 0", len(sender.calls))
	}
}

func TestForgotPassword_DBLookupError_StillReturns200(t *testing.T) {
	t.Parallel()

	db := &fakeAuthDB{
		getUserByEmail: func(ctx context.Context, email string) (dbgen.User, error) {
			return dbgen.User{}, errors.New("db down")
		},
	}
	sender := &fakeEmailSender{}
	h := newForgotPasswordHandler(t, db, sender, "http://localhost:3000")

	body := bytes.NewBufferString(`{"email":"lawrence@example.com"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/forgot-password", body)
	rec := httptest.NewRecorder()
	h.ForgotPassword(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	wantBody := `{"data":{"message":"如果该邮箱已注册，你将收到重置链接"}}`
	if got := rec.Body.String(); got != wantBody {
		t.Errorf("body mismatch\n got: %s\nwant: %s", got, wantBody)
	}
	if db.setResetTokenCallCount != 0 {
		t.Errorf("SetResetPasswordToken called %d times after db lookup error, want 0", db.setResetTokenCallCount)
	}
	if len(sender.calls) != 0 {
		t.Errorf("sender invoked %d times after db lookup error, want 0", len(sender.calls))
	}
}

func TestForgotPassword_DBSetTokenError_StillReturns200(t *testing.T) {
	t.Parallel()

	user := fixtureUser(t)
	db := &fakeAuthDB{
		getUserByEmail: func(ctx context.Context, email string) (dbgen.User, error) {
			return user, nil
		},
		setResetPasswordTokenFn: func(ctx context.Context, id uuid.UUID, token *string, expires pgtype.Timestamptz) error {
			return errors.New("update failed")
		},
	}
	sender := &fakeEmailSender{}
	h := newForgotPasswordHandler(t, db, sender, "http://localhost:3000")

	body := bytes.NewBufferString(`{"email":"lawrence@example.com"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/forgot-password", body)
	rec := httptest.NewRecorder()
	h.ForgotPassword(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	// The DB call IS attempted (we want the operator to see the slog
	// failure) but the email is NOT sent — sending a token that didn't
	// persist would lock the user out.
	if db.setResetTokenCallCount != 1 {
		t.Errorf("SetResetPasswordToken called %d times, want 1", db.setResetTokenCallCount)
	}
	if len(sender.calls) != 0 {
		t.Errorf("sender invoked %d times after persist failure, want 0", len(sender.calls))
	}
}

func TestForgotPassword_SendEmailError_StillReturns200(t *testing.T) {
	t.Parallel()

	user := fixtureUser(t)
	db := &fakeAuthDB{
		getUserByEmail: func(ctx context.Context, email string) (dbgen.User, error) {
			return user, nil
		},
	}
	sender := &fakeEmailSender{err: errors.New("smtp timeout")}
	h := newForgotPasswordHandler(t, db, sender, "http://localhost:3000")

	body := bytes.NewBufferString(`{"email":"lawrence@example.com"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/forgot-password", body)
	rec := httptest.NewRecorder()
	h.ForgotPassword(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	// Token IS persisted; the email failure is logged, not surfaced.
	if db.setResetTokenCallCount != 1 {
		t.Errorf("SetResetPasswordToken count = %d, want 1", db.setResetTokenCallCount)
	}
	if len(sender.calls) != 1 {
		t.Errorf("sender call count = %d, want 1", len(sender.calls))
	}
}

func TestForgotPassword_TokenIsHex64(t *testing.T) {
	t.Parallel()

	user := fixtureUser(t)
	db := &fakeAuthDB{
		getUserByEmail: func(ctx context.Context, email string) (dbgen.User, error) {
			return user, nil
		},
	}
	sender := &fakeEmailSender{}
	h := newForgotPasswordHandler(t, db, sender, "http://localhost:3000")

	body := bytes.NewBufferString(`{"email":"lawrence@example.com"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/forgot-password", body)
	rec := httptest.NewRecorder()
	h.ForgotPassword(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if len(sender.calls) != 1 {
		t.Fatalf("sender call count = %d, want 1", len(sender.calls))
	}
	token := extractTokenFromResetURL(t, sender.calls[0].resetURL)
	if !hex64Pattern.MatchString(token) {
		t.Errorf("token = %q, want 64-char hex", token)
	}
	// And the DB-side token matches the one in the URL — they must
	// stay in sync or the user can never redeem the link.
	if db.setResetTokenCalledToken == nil || *db.setResetTokenCalledToken != token {
		t.Errorf("DB token = %v, URL token = %s — mismatch", db.setResetTokenCalledToken, token)
	}
}

func TestForgotPassword_ResetURL_Format(t *testing.T) {
	t.Parallel()

	user := fixtureUser(t)
	db := &fakeAuthDB{
		getUserByEmail: func(ctx context.Context, email string) (dbgen.User, error) {
			return user, nil
		},
	}
	sender := &fakeEmailSender{}
	h := newForgotPasswordHandler(t, db, sender, "http://localhost:3000")

	body := bytes.NewBufferString(`{"email":"lawrence@example.com"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/forgot-password", body)
	rec := httptest.NewRecorder()
	h.ForgotPassword(rec, req)

	if len(sender.calls) != 1 {
		t.Fatalf("sender call count = %d, want 1", len(sender.calls))
	}
	if !strings.HasPrefix(sender.calls[0].resetURL, "http://localhost:3000/reset-password/") {
		t.Errorf("resetURL = %q, want prefix http://localhost:3000/reset-password/", sender.calls[0].resetURL)
	}
	if strings.Contains(sender.calls[0].resetURL, "//reset-password") {
		t.Errorf("resetURL has double slash before path: %s", sender.calls[0].resetURL)
	}
}

func TestForgotPassword_ResetURL_TrimsTrailingSlash(t *testing.T) {
	t.Parallel()

	user := fixtureUser(t)
	db := &fakeAuthDB{
		getUserByEmail: func(ctx context.Context, email string) (dbgen.User, error) {
			return user, nil
		},
	}
	sender := &fakeEmailSender{}
	// Trailing slash on the origin — handler must trim before joining
	// or the URL would have a double slash.
	h := newForgotPasswordHandler(t, db, sender, "http://localhost:3000/")

	body := bytes.NewBufferString(`{"email":"lawrence@example.com"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/forgot-password", body)
	rec := httptest.NewRecorder()
	h.ForgotPassword(rec, req)

	if len(sender.calls) != 1 {
		t.Fatalf("sender call count = %d, want 1", len(sender.calls))
	}
	if !strings.HasPrefix(sender.calls[0].resetURL, "http://localhost:3000/reset-password/") {
		t.Errorf("resetURL = %q, want prefix http://localhost:3000/reset-password/", sender.calls[0].resetURL)
	}
	if strings.Contains(sender.calls[0].resetURL, "//reset-password") {
		t.Errorf("trailing-slash origin produced double slash: %s", sender.calls[0].resetURL)
	}
}

func TestForgotPassword_NilEmailSender_FallsBackToNoop(t *testing.T) {
	t.Parallel()

	user := fixtureUser(t)
	db := &fakeAuthDB{
		getUserByEmail: func(ctx context.Context, email string) (dbgen.User, error) {
			return user, nil
		},
	}
	// nil sender — NewHandlers must substitute NoopSender (otherwise
	// the SendPasswordReset call would nil-panic).
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 7*24*time.Hour, false)

	body := bytes.NewBufferString(`{"email":"lawrence@example.com"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/forgot-password", body)
	rec := httptest.NewRecorder()
	h.ForgotPassword(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
}

func TestForgotPassword_BadJSON_400(t *testing.T) {
	t.Parallel()

	db := &fakeAuthDB{}
	sender := &fakeEmailSender{}
	h := newForgotPasswordHandler(t, db, sender, "http://localhost:3000")

	body := bytes.NewBufferString(`{not-json`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/forgot-password", body)
	rec := httptest.NewRecorder()
	h.ForgotPassword(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

// -----------------------------------------------------------------------------
// ResetPassword (P2.2.1)
// -----------------------------------------------------------------------------

// resetPasswordRouter wraps h.ResetPassword in a chi router so
// chi.URLParam can resolve {token}.  Calling h.ResetPassword directly
// via httptest.NewRequest would see an empty token string.
func resetPasswordRouter(h *Handlers) http.Handler {
	r := chi.NewRouter()
	r.Post("/api/auth/reset-password/{token}", h.ResetPassword)
	return r
}

func TestResetPassword_HappyPath_200(t *testing.T) {
	t.Parallel()

	user := fixtureUser(t)
	db := &fakeAuthDB{
		getUserByResetTokenFn: func(ctx context.Context, token *string) (dbgen.User, error) {
			return user, nil
		},
	}
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 7*24*time.Hour, false)

	body := bytes.NewBufferString(`{"password":"newPassword123"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/reset-password/sometoken", body)
	rec := httptest.NewRecorder()
	resetPasswordRouter(h).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	wantBody := `{"data":{"message":"密码已重置，请重新登录"}}`
	if got := rec.Body.String(); got != wantBody {
		t.Errorf("body mismatch\n got: %s\nwant: %s", got, wantBody)
	}

	if db.resetPasswordCallCount != 1 {
		t.Fatalf("ResetUserPassword call count = %d, want 1", db.resetPasswordCallCount)
	}
	if db.resetPasswordCalledID != user.ID {
		t.Errorf("ResetUserPassword id = %s, want %s", db.resetPasswordCalledID, user.ID)
	}
	// Verify the password is a bcrypt hash of "newPassword123".  This
	// confirms the handler hashes before storing — never accepts the
	// plaintext on the way through.
	if db.resetPasswordCalledPassword == "newPassword123" {
		t.Error("stored value equals plaintext — handler did not hash")
	}
	if err := jwtx.ComparePassword(db.resetPasswordCalledPassword, "newPassword123"); err != nil {
		t.Errorf("stored hash does not match plaintext: %v", err)
	}
}

func TestResetPassword_TokenNotFound_400(t *testing.T) {
	t.Parallel()

	db := &fakeAuthDB{
		getUserByResetTokenFn: func(ctx context.Context, token *string) (dbgen.User, error) {
			return dbgen.User{}, pgx.ErrNoRows
		},
	}
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 7*24*time.Hour, false)

	body := bytes.NewBufferString(`{"password":"newPassword123"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/reset-password/bad-token", body)
	rec := httptest.NewRecorder()
	resetPasswordRouter(h).ServeHTTP(rec, req)

	assertError(t, rec, http.StatusBadRequest, "INVALID_TOKEN", "链接无效或已过期，请重新申请")
	if db.resetPasswordCallCount != 0 {
		t.Errorf("ResetUserPassword called %d times on invalid token, want 0", db.resetPasswordCallCount)
	}
}

func TestResetPassword_PasswordTooShort_400(t *testing.T) {
	t.Parallel()

	// GetUserByResetTokenFn left nil intentionally — handler must
	// short-circuit on validation BEFORE the DB lookup.  If the test
	// hits the panic, the validation order regressed.
	db := &fakeAuthDB{}
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 7*24*time.Hour, false)

	body := bytes.NewBufferString(`{"password":"12345"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/reset-password/sometoken", body)
	rec := httptest.NewRecorder()
	resetPasswordRouter(h).ServeHTTP(rec, req)

	assertError(t, rec, http.StatusBadRequest, "VALIDATION_ERROR", "密码至少 6 位")
}

func TestResetPassword_PasswordEmpty_400(t *testing.T) {
	t.Parallel()

	db := &fakeAuthDB{}
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 7*24*time.Hour, false)

	body := bytes.NewBufferString(`{"password":""}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/reset-password/sometoken", body)
	rec := httptest.NewRecorder()
	resetPasswordRouter(h).ServeHTTP(rec, req)

	assertError(t, rec, http.StatusBadRequest, "VALIDATION_ERROR", "密码至少 6 位")
}

func TestResetPassword_EmptyTokenPath_400(t *testing.T) {
	t.Parallel()

	// Direct invocation (no chi router) — chi.URLParam returns "" so
	// the handler should treat as invalid-token without ever touching
	// the DB.
	db := &fakeAuthDB{}
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 7*24*time.Hour, false)

	body := bytes.NewBufferString(`{"password":"newPassword123"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/reset-password/", body)
	rec := httptest.NewRecorder()
	h.ResetPassword(rec, req)

	assertError(t, rec, http.StatusBadRequest, "INVALID_TOKEN", "链接无效或已过期，请重新申请")
}

func TestResetPassword_ExpiredToken_StillReturns400(t *testing.T) {
	t.Parallel()

	// Expired tokens surface as ErrNoRows because the SQL `WHERE
	// reset_password_expires > now()` filter drops them at read time.
	// We must NOT differentiate the message — leaking expired-vs-never
	// would let an attacker probe whether a given token ever lived.
	db := &fakeAuthDB{
		getUserByResetTokenFn: func(ctx context.Context, token *string) (dbgen.User, error) {
			return dbgen.User{}, pgx.ErrNoRows
		},
	}
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 7*24*time.Hour, false)

	body := bytes.NewBufferString(`{"password":"newPassword123"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/reset-password/expired-token", body)
	rec := httptest.NewRecorder()
	resetPasswordRouter(h).ServeHTTP(rec, req)

	assertError(t, rec, http.StatusBadRequest, "INVALID_TOKEN", "链接无效或已过期，请重新申请")
}

func TestResetPassword_DBLookupError_500(t *testing.T) {
	t.Parallel()

	db := &fakeAuthDB{
		getUserByResetTokenFn: func(ctx context.Context, token *string) (dbgen.User, error) {
			return dbgen.User{}, errors.New("db down")
		},
	}
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 7*24*time.Hour, false)

	body := bytes.NewBufferString(`{"password":"newPassword123"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/reset-password/sometoken", body)
	rec := httptest.NewRecorder()
	resetPasswordRouter(h).ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
}

func TestResetPassword_ResetWriteError_500(t *testing.T) {
	t.Parallel()

	user := fixtureUser(t)
	db := &fakeAuthDB{
		getUserByResetTokenFn: func(ctx context.Context, token *string) (dbgen.User, error) {
			return user, nil
		},
		resetUserPasswordFn: func(ctx context.Context, id uuid.UUID, password string) error {
			return errors.New("write failed")
		},
	}
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 7*24*time.Hour, false)

	body := bytes.NewBufferString(`{"password":"newPassword123"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/reset-password/sometoken", body)
	rec := httptest.NewRecorder()
	resetPasswordRouter(h).ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
}

func TestResetPassword_BadJSON_400(t *testing.T) {
	t.Parallel()

	db := &fakeAuthDB{}
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 7*24*time.Hour, false)

	body := bytes.NewBufferString(`{not-json`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/reset-password/sometoken", body)
	rec := httptest.NewRecorder()
	resetPasswordRouter(h).ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

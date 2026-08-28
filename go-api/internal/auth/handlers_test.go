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
	// updateRefreshCallCount makes "the DB was never touched" an explicit
	// assertion.  Logout clears cookies unconditionally but must only write
	// when the refresh cookie verifies, and a zero uuid is too easy to read
	// as "called with the zero value".
	updateRefreshCallCount int

	// RotateRefreshToken captures the call so tests can assert the rotation
	// happened (or didn't, on a grace hit).
	//
	// rotateCASEnabled + rotateCASCurrent MODEL THE WHERE CLAUSE.  The real
	// query only swaps when refresh_token still equals expectedToken; a fake
	// that ignores that would let a reversed argument order — the hazard the
	// generated positional signature creates, since newToken and
	// expectedToken are both *string — pass every test here while the CAS
	// matched nothing in production.
	//
	// Two fields rather than one because nil is a real value: with
	// rotateCASEnabled set, rotateCASCurrent == nil means "the row's
	// refresh_token IS NULL", which no expectedToken can ever equal.  A
	// single *string would conflate that with "don't model the predicate".
	rotateCASEnabled        bool
	rotateCASCurrent        *string
	rotateRefreshTokenFn    func(ctx context.Context, newToken *string, id uuid.UUID, expectedToken *string) (dbgen.RotateRefreshTokenRow, error)
	rotateRefreshCalledWith *string
	rotateRefreshExpected   *string
	rotateRefreshCalledID   uuid.UUID
	rotateRefreshCallCount  int
	// rotateCASMissCount counts swaps the predicate refused.  Since the
	// check moved into the WHERE clause, "the grace path did not rotate"
	// is no longer "the query was never issued" — the query IS the check.
	// The invariant to assert is that it matched nothing.
	rotateCASMissCount int

	// Logout's CAS.  Same reasoning as rotateCAS above, for the other
	// predicate: ClearRefreshTokenIfMatches only clears when the presented
	// token still equals refresh_token OR previous_refresh_token, and a fake
	// that ignored that would report success for a stale token replayed as a
	// forced-logout — precisely the abuse the predicate was added to remove.
	//
	// clearCASEnabled gates the modelling for the same nil-is-a-real-value
	// reason: with it set, both current and previous being nil means "this
	// row has no live session", which no presented token can match.
	clearCASEnabled     bool
	clearCASCurrent     *string
	clearCASPrevious    *string
	clearCalledWith     *string
	clearCalledID       uuid.UUID
	clearCallCount      int
	clearRowsAffected   int64
	clearRefreshTokenFn func(ctx context.Context, id uuid.UUID, presentedToken *string) (int64, error)

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

	setUserPublicFn        func(ctx context.Context, id uuid.UUID, isPublic bool) error
	setUserPublicCalledID  uuid.UUID
	setUserPublicCalledVal bool
	setUserPublicCallCount int
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
	f.updateRefreshCallCount++
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

// ClearRefreshTokenIfMatches models the predicate rather than just recording
// the call.  With clearCASEnabled, a presented token that matches neither the
// current nor the previous slot returns 0 rows — which is what makes
// "a revoked token cannot force a logout" an assertable property here instead
// of something only a real database could show.
func (f *fakeAuthDB) ClearRefreshTokenIfMatches(ctx context.Context, id uuid.UUID, presentedToken *string) (int64, error) {
	f.clearCallCount++
	f.clearCalledID = id
	if presentedToken != nil {
		v := *presentedToken
		f.clearCalledWith = &v
	} else {
		f.clearCalledWith = nil
	}
	if f.clearRefreshTokenFn != nil {
		return f.clearRefreshTokenFn(ctx, id, presentedToken)
	}
	if !f.clearCASEnabled {
		return f.clearRowsAffected, nil
	}
	matches := func(slot *string) bool {
		return slot != nil && presentedToken != nil && *slot == *presentedToken
	}
	if matches(f.clearCASCurrent) || matches(f.clearCASPrevious) {
		f.clearCASCurrent, f.clearCASPrevious = nil, nil
		return 1, nil
	}
	return 0, nil
}

// RotateRefreshToken captures the call, MODELS THE CAS PREDICATE, then
// delegates to rotateRefreshTokenFn if set.  rotateRefreshCallCount lets
// tests assert the normal rotation path fires (or does NOT, on a grace hit).
//
// The predicate matters: when rotateCASCurrent is set, a mismatch returns
// pgx.ErrNoRows exactly like Postgres would, so tests exercise the handler's
// "lost the race → re-read → grace" branch for real instead of trusting a
// fake that always succeeds.
func (f *fakeAuthDB) RotateRefreshToken(ctx context.Context, newToken *string, id uuid.UUID, expectedToken *string) (dbgen.RotateRefreshTokenRow, error) {
	f.rotateRefreshCalledID = id
	if newToken != nil {
		v := *newToken
		f.rotateRefreshCalledWith = &v
	} else {
		f.rotateRefreshCalledWith = nil
	}
	if expectedToken != nil {
		v := *expectedToken
		f.rotateRefreshExpected = &v
	} else {
		f.rotateRefreshExpected = nil
	}
	f.rotateRefreshCallCount++

	if f.rotateCASEnabled {
		matched := f.rotateCASCurrent != nil &&
			expectedToken != nil &&
			*expectedToken == *f.rotateCASCurrent
		if !matched {
			f.rotateCASMissCount++
			return dbgen.RotateRefreshTokenRow{}, pgx.ErrNoRows
		}
	}
	if f.rotateRefreshTokenFn == nil {
		return dbgen.RotateRefreshTokenRow{Username: "tester"}, nil
	}
	return f.rotateRefreshTokenFn(ctx, newToken, id, expectedToken)
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

// Self-serve account mutation stubs (PATCH /api/auth/me + change-password).
// No existing test exercises these endpoints yet; zero-value returns keep
// fakeAuthDB satisfying the AuthDB interface.
func (f *fakeAuthDB) UpdateUsername(ctx context.Context, id uuid.UUID, username string) (dbgen.User, error) {
	return dbgen.User{ID: id, Username: username}, nil
}
func (f *fakeAuthDB) SetUserAvatar(ctx context.Context, id uuid.UUID, avatarUrl *string) error {
	return nil
}
func (f *fakeAuthDB) SetUserBackdrop(ctx context.Context, id uuid.UUID, backdropAnilistID *int32) error {
	return nil
}
func (f *fakeAuthDB) SetUserPublic(ctx context.Context, id uuid.UUID, isPublic bool) error {
	f.setUserPublicCalledID = id
	f.setUserPublicCalledVal = isPublic
	f.setUserPublicCallCount++
	if f.setUserPublicFn == nil {
		return nil
	}
	return f.setUserPublicFn(ctx, id, isPublic)
}
func (f *fakeAuthDB) UpdateUserPassword(ctx context.Context, id uuid.UUID, password string) error {
	return nil
}
func (f *fakeAuthDB) GetAnimeImages(ctx context.Context, anilistID int32) (dbgen.GetAnimeImagesRow, error) {
	return dbgen.GetAnimeImagesRow{}, nil
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
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)

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

	h := NewHandlers(&fakeAuthDB{}, newTestSigner(t), nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)
	body := bytes.NewBufferString(`{"username":"ab","email":"x@example.com","password":"correct-horse"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/register", body)
	rec := httptest.NewRecorder()
	h.Register(rec, req)

	assertError(t, rec, http.StatusBadRequest, "VALIDATION_ERROR", "Username must be 3-50 characters")
}

func TestRegister_InvalidEmail_400(t *testing.T) {
	t.Parallel()

	h := NewHandlers(&fakeAuthDB{}, newTestSigner(t), nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)
	body := bytes.NewBufferString(`{"username":"lawrence","email":"not-an-email","password":"correct-horse"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/register", body)
	rec := httptest.NewRecorder()
	h.Register(rec, req)

	assertError(t, rec, http.StatusBadRequest, "VALIDATION_ERROR", "Invalid email format")
}

func TestRegister_PasswordTooShort_400(t *testing.T) {
	t.Parallel()

	h := NewHandlers(&fakeAuthDB{}, newTestSigner(t), nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)
	body := bytes.NewBufferString(`{"username":"lawrence","email":"x@example.com","password":"12345"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/register", body)
	rec := httptest.NewRecorder()
	h.Register(rec, req)

	assertError(t, rec, http.StatusBadRequest, "VALIDATION_ERROR", "Password must be at least 6 characters")
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
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)
	body := bytes.NewBufferString(`{"username":"lawrence","email":"taken@example.com","password":"correct-horse"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/register", body)
	rec := httptest.NewRecorder()
	h.Register(rec, req)

	assertError(t, rec, http.StatusBadRequest, "DUPLICATE_ERROR", "Username or email already exists")
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
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)
	body := bytes.NewBufferString(`{"username":"lawrence","email":"new@example.com","password":"correct-horse"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/register", body)
	rec := httptest.NewRecorder()
	h.Register(rec, req)

	assertError(t, rec, http.StatusBadRequest, "DUPLICATE_ERROR", "Username or email already exists")
}

func TestRegister_BadJSON_400(t *testing.T) {
	t.Parallel()

	h := NewHandlers(&fakeAuthDB{}, newTestSigner(t), nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)
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
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)

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
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)

	body := bytes.NewBufferString(`{"email":"ghost@example.com","password":"whatever"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", body)
	rec := httptest.NewRecorder()
	h.Login(rec, req)

	assertError(t, rec, http.StatusUnauthorized, "INVALID_CREDENTIALS", "Invalid email or password")
}

func TestLogin_BadPassword_401(t *testing.T) {
	t.Parallel()

	user := fixtureUser(t)
	db := &fakeAuthDB{
		getUserByEmail: func(ctx context.Context, email string) (dbgen.User, error) {
			return user, nil
		},
	}
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)

	body := bytes.NewBufferString(`{"email":"lawrence@example.com","password":"wrong-pony"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", body)
	rec := httptest.NewRecorder()
	h.Login(rec, req)

	// Same message as bad-email — no enumeration.
	assertError(t, rec, http.StatusUnauthorized, "INVALID_CREDENTIALS", "Invalid email or password")
}

func TestLogin_MissingPassword_400(t *testing.T) {
	t.Parallel()

	h := NewHandlers(&fakeAuthDB{}, newTestSigner(t), nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)
	body := bytes.NewBufferString(`{"email":"lawrence@example.com","password":""}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", body)
	rec := httptest.NewRecorder()
	h.Login(rec, req)

	assertError(t, rec, http.StatusBadRequest, "VALIDATION_ERROR", "Password is required")
}

// -----------------------------------------------------------------------------
// Refresh
// -----------------------------------------------------------------------------

func TestRefresh_NoCookie_401_NoToken(t *testing.T) {
	t.Parallel()

	h := NewHandlers(&fakeAuthDB{}, newTestSigner(t), nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/refresh", nil)
	rec := httptest.NewRecorder()
	h.Refresh(rec, req)

	assertError(t, rec, http.StatusUnauthorized, "NO_TOKEN", "Please log in again")
}

func TestRefresh_BadToken_401_InvalidToken(t *testing.T) {
	t.Parallel()

	h := NewHandlers(&fakeAuthDB{}, newTestSigner(t), nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/refresh", nil)
	req.AddCookie(&http.Cookie{Name: RefreshCookieName, Value: "not-a-jwt"})
	rec := httptest.NewRecorder()
	h.Refresh(rec, req)

	assertError(t, rec, http.StatusUnauthorized, "INVALID_TOKEN", "Invalid token")
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
		// The row holds a different token, so the CAS matches nothing —
		// this check now lives in the WHERE clause, not in Go.
		rotateCASEnabled: true,
		rotateCASCurrent: &storedToken,
		getUserByID: func(ctx context.Context, id uuid.UUID) (dbgen.User, error) {
			return user, nil
		},
	}
	h := NewHandlers(db, signer, nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/refresh", nil)
	req.AddCookie(&http.Cookie{Name: RefreshCookieName, Value: cookieToken})
	rec := httptest.NewRecorder()
	h.Refresh(rec, req)

	assertError(t, rec, http.StatusUnauthorized, "INVALID_TOKEN", "Invalid token")
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
		// refresh_token IS NULL: no expectedToken can equal it, so the CAS
		// matches nothing and the grace re-read finds nothing either.
		rotateCASEnabled: true,
		rotateCASCurrent: nil,
		getUserByID: func(ctx context.Context, id uuid.UUID) (dbgen.User, error) {
			return user, nil
		},
	}
	h := NewHandlers(db, signer, nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/refresh", nil)
	req.AddCookie(&http.Cookie{Name: RefreshCookieName, Value: cookieToken})
	rec := httptest.NewRecorder()
	h.Refresh(rec, req)

	assertError(t, rec, http.StatusUnauthorized, "INVALID_TOKEN", "Invalid token")
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
	h := NewHandlers(db, signer, nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)
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

	// After normal rotation, RotateRefreshToken must have been called once.
	if db.rotateRefreshCallCount != 1 {
		t.Errorf("RotateRefreshToken call count = %d, want 1", db.rotateRefreshCallCount)
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
	signer := newTestSigner(t)
	h := NewHandlers(db, signer, nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)

	req := httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	req, tok := withRefreshCookieToken(t, req, signer, user.ID)
	db.clearCASEnabled = true
	db.clearCASCurrent = &tok
	rec := httptest.NewRecorder()
	h.Logout(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}

	// DB-side: the CAS clear ran, against this user, carrying the presented
	// token.  The token argument is the load-bearing one — it is what stops a
	// stale-but-signed cookie from clearing somebody's live session.
	if db.clearCallCount != 1 {
		t.Errorf("ClearRefreshTokenIfMatches called %d times, want 1", db.clearCallCount)
	}
	if db.clearCalledID != user.ID {
		t.Errorf("ClearRefreshTokenIfMatches id = %s, want %s", db.clearCalledID, user.ID)
	}
	if db.clearCalledWith == nil || *db.clearCalledWith != tok {
		t.Errorf("ClearRefreshTokenIfMatches token = %v, want the presented cookie value", db.clearCalledWith)
	}

	// Cookie-side: Set-Cookie has MaxAge<=0.
	c := getSetCookie(rec, RefreshCookieName)
	if c == nil {
		t.Fatal("no refreshToken cookie cleared")
	}
	if c.MaxAge > 0 {
		t.Errorf("MaxAge = %d, want <= 0", c.MaxAge)
	}

	// Body: {"data":{"message":"Logged out"}}
	var data MessageData
	decodeData(t, rec.Body.Bytes(), &data)
	if data.Message != "Logged out" {
		t.Errorf("message = %q, want Logged out", data.Message)
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
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)

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
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)

	req := httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
	req = req.WithContext(injectClaims(req.Context(), user.ID, user.Username, user.Role))
	rec := httptest.NewRecorder()
	h.Me(rec, req)

	assertError(t, rec, http.StatusNotFound, "NOT_FOUND", "User not found")
}

func TestMe_NoClaims_500(t *testing.T) {
	t.Parallel()

	h := NewHandlers(&fakeAuthDB{}, newTestSigner(t), nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)
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
// withRefreshCookie signs a refresh token for id and attaches it to req the
// way a browser would.
//
// Logout authenticates from this cookie, not from access claims: it no
// longer runs behind RequireAuth (gating it on a 15-minute access token
// meant an idle tab could never actually log out), so ctx never carries
// claims there.  Tests that used injectClaims for Logout must use this.
func withRefreshCookie(t *testing.T, req *http.Request, s *jwtx.Signer, id uuid.UUID) *http.Request {
	t.Helper()
	req, _ = withRefreshCookieToken(t, req, s, id)
	return req
}

// withRefreshCookieToken is withRefreshCookie plus the token it minted.
// Logout's DB write is now predicated on the presented value, so a test that
// wants the clear to succeed has to seed the fake row with the SAME token —
// otherwise it is asserting against a row the caller does not hold, which is
// the case the predicate is designed to reject.
func withRefreshCookieToken(t *testing.T, req *http.Request, s *jwtx.Signer, id uuid.UUID) (*http.Request, string) {
	t.Helper()
	tok, err := s.SignRefresh(id)
	if err != nil {
		t.Fatalf("SignRefresh: %v", err)
	}
	req.AddCookie(&http.Cookie{Name: RefreshCookieName, Value: tok})
	return req, tok
}

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
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)
	body := bytes.NewBufferString(`{"username":"lawrence","email":"x@example.com","password":"correct-horse"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/register", body)
	rec := httptest.NewRecorder()
	h.Register(rec, req)

	assertError(t, rec, http.StatusBadRequest, "DUPLICATE_ERROR", "Username or email already exists")
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
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)
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
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)
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
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)
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

	h := NewHandlers(&fakeAuthDB{}, newTestSigner(t), nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)
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
		// No such row, so the CAS updates nothing; the re-read that follows
		// also finds nothing and the request ends as INVALID_TOKEN.
		rotateCASEnabled: true,
		rotateCASCurrent: nil,
		getUserByID: func(ctx context.Context, id uuid.UUID) (dbgen.User, error) {
			return dbgen.User{}, pgx.ErrNoRows
		},
	}
	h := NewHandlers(db, signer, nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/refresh", nil)
	req.AddCookie(&http.Cookie{Name: RefreshCookieName, Value: cookieToken})
	rec := httptest.NewRecorder()
	h.Refresh(rec, req)

	assertError(t, rec, http.StatusUnauthorized, "INVALID_TOKEN", "Invalid token")
}

// assertAuthCookiesCleared checks all three auth cookies carry an expiring
// Set-Cookie.  Logout must emit these on EVERY path, authenticated or not —
// clearing the caller's own browser is never something we withhold.
func assertAuthCookiesCleared(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	for _, name := range []string{RefreshCookieName, sessionCookieName, AuthHintCookieName} {
		c := getSetCookie(rec, name)
		if c == nil {
			t.Errorf("cookie %q was not cleared (no Set-Cookie)", name)
			continue
		}
		if c.MaxAge > 0 {
			t.Errorf("cookie %q MaxAge = %d, want <= 0", name, c.MaxAge)
		}
	}
}

// ---------------------------------------------------------------------------
// REGRESSION — logout used to be a no-op once the access token expired.
//
// Logout sat behind jwtx.RequireAuth while the access cookie lives only
// accessTTL (15m).  A tab idle past that window got a 401 from the
// middleware and the handler NEVER RAN: no Clear-Cookie headers, no DB
// write.  The browser kept its 7-day refresh cookie, next-app's proxy.ts
// saw needsRefresh(session)==true (the access token had expired — that is
// exactly why logout 401'd) plus a live refreshToken, refreshed, and signed
// the user straight back in.  The UI said logged out; the session was not.
//
// Deterministic, not a race.  These three tests are what keep it fixed.
// ---------------------------------------------------------------------------

// The bug itself: no access claims in ctx at all (what RequireAuth's absence
// looks like from the handler's side) plus a valid refresh cookie must still
// end the session server-side.
func TestLogout_NoAccessClaims_StillEndsSessionInDB(t *testing.T) {
	t.Parallel()

	user := fixtureUser(t)
	signer := newTestSigner(t)
	db := &fakeAuthDB{clearCASEnabled: true}
	h := NewHandlers(db, signer, nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)

	req := httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	req, tok := withRefreshCookieToken(t, req, signer, user.ID)
	// The row holds exactly the token the tab is presenting — an idle tab's
	// refresh cookie is still the live one, which is why adding the predicate
	// does not reinstate the bug this test guards.
	db.clearCASCurrent = &tok
	rec := httptest.NewRecorder()
	h.Logout(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if db.clearCallCount != 1 {
		t.Fatalf("ClearRefreshTokenIfMatches called %d times, want 1 — "+
			"an expired access token must not stop the session from ending",
			db.clearCallCount)
	}
	if db.clearCalledID != user.ID {
		t.Errorf("ended session for %s, want %s", db.clearCalledID, user.ID)
	}
	if db.clearCASCurrent != nil {
		t.Errorf("the row still holds a live refresh token after logout: %v", *db.clearCASCurrent)
	}
	assertAuthCookiesCleared(t, rec)
}

// No credentials at all: still 200, still clears cookies, but must NOT
// touch the DB — we do not null a user row on an unverified claim.
func TestLogout_NoCredentials_ClearsCookiesWithoutDBWrite(t *testing.T) {
	t.Parallel()

	db := &fakeAuthDB{}
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)

	req := httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	rec := httptest.NewRecorder()
	h.Logout(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 — logout must always succeed", rec.Code)
	}
	if db.updateRefreshCallCount != 0 {
		t.Errorf("UpdateUserRefreshToken called %d times, want 0 with no credentials",
			db.updateRefreshCallCount)
	}
	assertAuthCookiesCleared(t, rec)
}

// A refresh cookie we did not sign proves nothing.  Cookies still clear
// (harmless, and it is the caller's own browser); the DB stays untouched.
func TestLogout_ForgedRefreshCookie_ClearsCookiesWithoutDBWrite(t *testing.T) {
	t.Parallel()

	db := &fakeAuthDB{}
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)

	req := httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	req.AddCookie(&http.Cookie{Name: RefreshCookieName, Value: "not.a.valid.jwt"})
	rec := httptest.NewRecorder()
	h.Logout(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 — failures must not be distinguishable", rec.Code)
	}
	if db.updateRefreshCallCount != 0 {
		t.Errorf("UpdateUserRefreshToken called %d times, want 0 for an unverified cookie",
			db.updateRefreshCallCount)
	}
	assertAuthCookiesCleared(t, rec)
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
	if msg != "Invalid request" {
		t.Errorf("validationMessage = %q, want generic %q", msg, "Invalid request")
	}
}

func TestValidationMessage_NonValidatorError(t *testing.T) {
	t.Parallel()
	msg := validationMessage(errors.New("not a validator error"))
	if msg != "Invalid request" {
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
// auth_hint cookie — non-httpOnly session-existence hint
// -----------------------------------------------------------------------------

// TestAuthHint_SetOnLogin asserts that a successful login response includes
// auth_hint=1 with HttpOnly UNSET so client JS can read it.
func TestAuthHint_SetOnLogin(t *testing.T) {
	t.Parallel()

	user := fixtureUser(t)
	db := &fakeAuthDB{
		getUserByEmail: func(ctx context.Context, email string) (dbgen.User, error) {
			return user, nil
		},
	}
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)

	body := bytes.NewBufferString(`{"email":"lawrence@example.com","password":"correct-horse"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", body)
	rec := httptest.NewRecorder()
	h.Login(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}

	c := getSetCookie(rec, AuthHintCookieName)
	if c == nil {
		t.Fatal("auth_hint cookie not set on login")
	}
	if c.Value != "1" {
		t.Errorf("auth_hint value = %q, want \"1\"", c.Value)
	}
	if c.HttpOnly {
		t.Error("auth_hint HttpOnly = true, want false (client JS must be able to read it)")
	}
	if c.MaxAge <= 0 {
		t.Errorf("auth_hint MaxAge = %d, want > 0", c.MaxAge)
	}
	if c.Path != "/" {
		t.Errorf("auth_hint Path = %q, want \"/\"", c.Path)
	}
}

// TestAuthHint_SetOnRegister asserts that a successful register response
// includes auth_hint=1 with HttpOnly UNSET.
func TestAuthHint_SetOnRegister(t *testing.T) {
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
			out := user
			out.Username = username
			out.Email = email
			out.Password = password
			return out, nil
		},
	}
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)

	body := bytes.NewBufferString(`{"username":"lawrence","email":"new@example.com","password":"correct-horse"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/register", body)
	rec := httptest.NewRecorder()
	h.Register(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body=%s", rec.Code, rec.Body.String())
	}

	c := getSetCookie(rec, AuthHintCookieName)
	if c == nil {
		t.Fatal("auth_hint cookie not set on register")
	}
	if c.Value != "1" {
		t.Errorf("auth_hint value = %q, want \"1\"", c.Value)
	}
	if c.HttpOnly {
		t.Error("auth_hint HttpOnly = true, want false")
	}
}

// TestAuthHint_SetOnRefresh_NormalPath asserts that a successful refresh
// (normal rotation) includes auth_hint=1 with HttpOnly UNSET.
func TestAuthHint_SetOnRefresh_NormalPath(t *testing.T) {
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
	h := NewHandlers(db, signer, nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/refresh", nil)
	req.AddCookie(&http.Cookie{Name: RefreshCookieName, Value: cookieToken})
	rec := httptest.NewRecorder()
	h.Refresh(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}

	c := getSetCookie(rec, AuthHintCookieName)
	if c == nil {
		t.Fatal("auth_hint cookie not set on refresh (normal path)")
	}
	if c.Value != "1" {
		t.Errorf("auth_hint value = %q, want \"1\"", c.Value)
	}
	if c.HttpOnly {
		t.Error("auth_hint HttpOnly = true, want false")
	}
	if c.MaxAge <= 0 {
		t.Errorf("auth_hint MaxAge = %d, want > 0", c.MaxAge)
	}
}

// TestAuthHint_SetOnRefresh_GracePath asserts that a refresh on the grace
// path also sets auth_hint=1 with HttpOnly UNSET.
func TestAuthHint_SetOnRefresh_GracePath(t *testing.T) {
	t.Parallel()

	signer := newTestSigner(t)
	user := fixtureUser(t)

	oldToken, err := signer.SignRefresh(user.ID)
	if err != nil {
		t.Fatalf("SignRefresh old: %v", err)
	}
	currentToken := "current-token-sentinel-auth-hint"
	user.RefreshToken = &currentToken
	user.PreviousRefreshToken = &oldToken
	user.RefreshRotatedAt = pgtype.Timestamptz{Time: time.Now(), Valid: true}

	db := &fakeAuthDB{
		// The winning request already swapped current to currentToken, so
		// this one's CAS (expecting oldToken) matches nothing — which is
		// exactly what routes it into the grace branch instead of letting it
		// rotate a second time and erase oldToken from both slots.
		rotateCASEnabled: true,
		rotateCASCurrent: &currentToken,
		getUserByID: func(ctx context.Context, id uuid.UUID) (dbgen.User, error) {
			return user, nil
		},
	}
	h := NewHandlers(db, signer, nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/refresh", nil)
	req.AddCookie(&http.Cookie{Name: RefreshCookieName, Value: oldToken})
	rec := httptest.NewRecorder()
	h.Refresh(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}

	c := getSetCookie(rec, AuthHintCookieName)
	if c == nil {
		t.Fatal("auth_hint cookie not set on refresh (grace path)")
	}
	if c.Value != "1" {
		t.Errorf("auth_hint value = %q, want \"1\"", c.Value)
	}
	if c.HttpOnly {
		t.Error("auth_hint HttpOnly = true, want false")
	}
}

// TestAuthHint_ClearedOnLogout asserts that a successful logout response
// expires auth_hint (MaxAge <= 0) via a Set-Cookie header.
func TestAuthHint_ClearedOnLogout(t *testing.T) {
	t.Parallel()

	user := fixtureUser(t)
	db := &fakeAuthDB{}
	signer := newTestSigner(t)
	h := NewHandlers(db, signer, nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)

	req := httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	req = withRefreshCookie(t, req, signer, user.ID)
	rec := httptest.NewRecorder()
	h.Logout(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}

	c := getSetCookie(rec, AuthHintCookieName)
	if c == nil {
		t.Fatal("auth_hint Set-Cookie not present on logout")
	}
	if c.MaxAge > 0 {
		t.Errorf("auth_hint MaxAge = %d, want <= 0 (cleared)", c.MaxAge)
	}
}

// TestAuthHint_ProdMode verifies that in prod mode auth_hint is Secure=true
// and SameSite=None (matching the other prod cookies) but still HttpOnly=false.
func TestAuthHint_ProdMode(t *testing.T) {
	t.Parallel()

	rec := httptest.NewRecorder()
	SetAuthHintCookie(rec, time.Hour, true)
	c := getSetCookie(rec, AuthHintCookieName)
	if c == nil {
		t.Fatal("auth_hint cookie not set in prod mode")
	}
	if !c.Secure {
		t.Error("auth_hint Secure not set in prod mode")
	}
	if c.SameSite != http.SameSiteNoneMode {
		t.Errorf("auth_hint SameSite = %v, want None in prod", c.SameSite)
	}
	if c.HttpOnly {
		t.Error("auth_hint HttpOnly = true in prod mode, want false")
	}
	if c.Value != "1" {
		t.Errorf("auth_hint value = %q, want \"1\"", c.Value)
	}

	rec2 := httptest.NewRecorder()
	ClearAuthHintCookie(rec2, true)
	cc := getSetCookie(rec2, AuthHintCookieName)
	if cc == nil {
		t.Fatal("cleared auth_hint cookie not set in prod mode")
	}
	if cc.MaxAge >= 0 {
		t.Errorf("auth_hint MaxAge = %d after clear, want negative", cc.MaxAge)
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
	return NewHandlers(db, newTestSigner(t), sender, clientOrigin, 15*time.Minute, 7*24*time.Hour, false)
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
	wantBody := `{"data":{"message":"If the email is registered, you will receive a reset link"}}`
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
	wantBody := `{"data":{"message":"If the email is registered, you will receive a reset link"}}`
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

	assertError(t, rec, http.StatusBadRequest, "VALIDATION_ERROR", "Invalid email format")
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
	wantBody := `{"data":{"message":"If the email is registered, you will receive a reset link"}}`
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
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)

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
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)

	body := bytes.NewBufferString(`{"password":"newPassword123"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/reset-password/sometoken", body)
	rec := httptest.NewRecorder()
	resetPasswordRouter(h).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	wantBody := `{"data":{"message":"Password has been reset, please log in again"}}`
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
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)

	body := bytes.NewBufferString(`{"password":"newPassword123"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/reset-password/bad-token", body)
	rec := httptest.NewRecorder()
	resetPasswordRouter(h).ServeHTTP(rec, req)

	assertError(t, rec, http.StatusBadRequest, "INVALID_TOKEN", "The link is invalid or has expired, please request a new one")
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
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)

	body := bytes.NewBufferString(`{"password":"12345"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/reset-password/sometoken", body)
	rec := httptest.NewRecorder()
	resetPasswordRouter(h).ServeHTTP(rec, req)

	assertError(t, rec, http.StatusBadRequest, "VALIDATION_ERROR", "Password must be at least 6 characters")
}

func TestResetPassword_PasswordEmpty_400(t *testing.T) {
	t.Parallel()

	db := &fakeAuthDB{}
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)

	body := bytes.NewBufferString(`{"password":""}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/reset-password/sometoken", body)
	rec := httptest.NewRecorder()
	resetPasswordRouter(h).ServeHTTP(rec, req)

	assertError(t, rec, http.StatusBadRequest, "VALIDATION_ERROR", "Password must be at least 6 characters")
}

func TestResetPassword_EmptyTokenPath_400(t *testing.T) {
	t.Parallel()

	// Direct invocation (no chi router) — chi.URLParam returns "" so
	// the handler should treat as invalid-token without ever touching
	// the DB.
	db := &fakeAuthDB{}
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)

	body := bytes.NewBufferString(`{"password":"newPassword123"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/reset-password/", body)
	rec := httptest.NewRecorder()
	h.ResetPassword(rec, req)

	assertError(t, rec, http.StatusBadRequest, "INVALID_TOKEN", "The link is invalid or has expired, please request a new one")
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
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)

	body := bytes.NewBufferString(`{"password":"newPassword123"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/reset-password/expired-token", body)
	rec := httptest.NewRecorder()
	resetPasswordRouter(h).ServeHTTP(rec, req)

	assertError(t, rec, http.StatusBadRequest, "INVALID_TOKEN", "The link is invalid or has expired, please request a new one")
}

func TestResetPassword_DBLookupError_500(t *testing.T) {
	t.Parallel()

	db := &fakeAuthDB{
		getUserByResetTokenFn: func(ctx context.Context, token *string) (dbgen.User, error) {
			return dbgen.User{}, errors.New("db down")
		},
	}
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)

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
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)

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
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)

	body := bytes.NewBufferString(`{not-json`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/reset-password/sometoken", body)
	rec := httptest.NewRecorder()
	resetPasswordRouter(h).ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

// -----------------------------------------------------------------------------
// Refresh grace-window tests (concurrent-refresh race fix)
// -----------------------------------------------------------------------------

// TestRefresh_NormalRotate_200 verifies the NORMAL path: cookie matches the
// current DB refresh_token → 200, RotateRefreshToken called once.
func TestRefresh_NormalRotate_200(t *testing.T) {
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
	h := NewHandlers(db, signer, nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/refresh", nil)
	req.AddCookie(&http.Cookie{Name: RefreshCookieName, Value: cookieToken})
	rec := httptest.NewRecorder()
	h.Refresh(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}

	// RotateRefreshToken must have been called exactly once (not UpdateUserRefreshToken).
	if db.rotateRefreshCallCount != 1 {
		t.Errorf("RotateRefreshToken call count = %d, want 1", db.rotateRefreshCallCount)
	}
	if db.rotateRefreshCalledID != user.ID {
		t.Errorf("RotateRefreshToken id = %s, want %s", db.rotateRefreshCalledID, user.ID)
	}
	if db.rotateRefreshCalledWith == nil || *db.rotateRefreshCalledWith == "" {
		t.Error("RotateRefreshToken called with empty token")
	}

	// The new refresh cookie must be present and non-empty.
	c := getSetCookie(rec, RefreshCookieName)
	if c == nil || c.Value == "" {
		t.Error("new refresh cookie not set")
	}

	var data RefreshData
	decodeData(t, rec.Body.Bytes(), &data)
	if data.AccessToken == "" {
		t.Error("accessToken missing")
	}
}

// TestRefresh_GraceHit_200 verifies the GRACE path: cookie matches
// previous_refresh_token within the 30 s window →
//   - 200
//   - refresh cookie re-set to the CURRENT token (not a new one)
//   - RotateRefreshToken NOT called (no re-rotation)
//
// Note: JWT tokens signed within the same second are byte-identical because
// the payload only has second-precision timestamps.  To ensure the DB's
// current token is distinguishable from the cookie (grace) token, we set
// the DB's current token to a known distinct raw string — the handler only
// does string equality against it (it never JWT-verifies the current token).
func TestRefresh_GraceHit_200(t *testing.T) {
	t.Parallel()

	signer := newTestSigner(t)
	user := fixtureUser(t)

	// The cookie carries the old (previously-current) signed JWT.
	oldToken, err := signer.SignRefresh(user.ID)
	if err != nil {
		t.Fatalf("SignRefresh old: %v", err)
	}

	// The DB current token is a sentinel that proves the grace path
	// re-sets the cookie to the current token, not a freshly issued one.
	currentToken := "current-token-sentinel-after-rotation"

	// DB state after the first (winning) rotation: current=NEW, previous=OLD,
	// rotated_at=now (well within the 30 s window).
	user.RefreshToken = &currentToken
	user.PreviousRefreshToken = &oldToken
	user.RefreshRotatedAt = pgtype.Timestamptz{Time: time.Now(), Valid: true}

	db := &fakeAuthDB{
		// The winning request already swapped current to currentToken, so
		// this one's CAS (expecting oldToken) matches nothing — which is
		// exactly what routes it into the grace branch instead of letting it
		// rotate a second time and erase oldToken from both slots.
		rotateCASEnabled: true,
		rotateCASCurrent: &currentToken,
		getUserByID: func(ctx context.Context, id uuid.UUID) (dbgen.User, error) {
			return user, nil
		},
	}
	h := NewHandlers(db, signer, nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)

	// Second (concurrent) request arrives with the OLD token.
	req := httptest.NewRequest(http.MethodPost, "/api/auth/refresh", nil)
	req.AddCookie(&http.Cookie{Name: RefreshCookieName, Value: oldToken})
	rec := httptest.NewRecorder()
	h.Refresh(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}

	// No re-rotation on a grace hit.  The swap IS attempted — that attempt
	// is now the check — but the predicate must refuse it.  Re-rotating here
	// would write previous=oldToken (the token this request sent, already
	// stale on the winning request) and erase the only value that still
	// lets the loser recover.
	if db.rotateCASMissCount != 1 {
		t.Errorf("CAS misses = %d, want 1 — the grace hit must be a refused swap, not a landed one",
			db.rotateCASMissCount)
	}
	if db.rotateRefreshCallCount != 1 {
		t.Errorf("RotateRefreshToken called %d times, want exactly 1 attempt", db.rotateRefreshCallCount)
	}

	// Refresh cookie must be re-set to the CURRENT token (so the client catches up).
	c := getSetCookie(rec, RefreshCookieName)
	if c == nil {
		t.Fatal("refresh cookie not set on grace hit")
	}
	if c.Value != currentToken {
		t.Errorf("refresh cookie = %q, want current token %q", c.Value, currentToken)
	}

	// A new access token must be issued.
	var data RefreshData
	decodeData(t, rec.Body.Bytes(), &data)
	if data.AccessToken == "" {
		t.Error("accessToken missing in grace-hit response")
	}
}

// TestRefresh_GraceExpired_401 verifies that the grace window is enforced:
// same setup as GraceHit but refresh_rotated_at is 1 min ago → 401.
func TestRefresh_GraceExpired_401(t *testing.T) {
	t.Parallel()

	signer := newTestSigner(t)
	user := fixtureUser(t)

	// Cookie carries the old signed JWT.
	oldToken, err := signer.SignRefresh(user.ID)
	if err != nil {
		t.Fatalf("SignRefresh old: %v", err)
	}
	// DB current token is a distinct sentinel (see GraceHit note).
	currentToken := "current-token-sentinel-expired-grace"

	user.RefreshToken = &currentToken
	user.PreviousRefreshToken = &oldToken
	// Rotated 1 minute ago — well outside the 30 s grace window.
	user.RefreshRotatedAt = pgtype.Timestamptz{Time: time.Now().Add(-time.Minute), Valid: true}

	db := &fakeAuthDB{
		// Current is the sentinel, so the CAS on oldToken matches nothing
		// and the request falls through to the (expired) grace check.
		rotateCASEnabled: true,
		rotateCASCurrent: &currentToken,
		getUserByID: func(ctx context.Context, id uuid.UUID) (dbgen.User, error) {
			return user, nil
		},
	}
	h := NewHandlers(db, signer, nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)

	req := httptest.NewRequest(http.MethodPost, "/api/auth/refresh", nil)
	req.AddCookie(&http.Cookie{Name: RefreshCookieName, Value: oldToken})
	rec := httptest.NewRecorder()
	h.Refresh(rec, req)

	assertError(t, rec, http.StatusUnauthorized, "INVALID_TOKEN", "Invalid token")

	// The swap is attempted (that attempt is the check) but must be refused;
	// nothing may land on a row whose grace window has already closed.
	if db.rotateCASMissCount != 1 {
		t.Errorf("CAS misses = %d, want 1 — expired grace must still be a refused swap",
			db.rotateCASMissCount)
	}
	if db.rotateRefreshCallCount != 1 {
		t.Errorf("RotateRefreshToken called %d times, want exactly 1 attempt", db.rotateRefreshCallCount)
	}
}

// TestLogout_NullsBothTokenColumns verifies that logout clears both
// refresh_token AND previous_refresh_token (via UpdateUserRefreshToken(nil))
// so a grace-window token can't be replayed after logout.
func TestLogout_NullsBothTokenColumns(t *testing.T) {
	t.Parallel()

	user := fixtureUser(t)
	db := &fakeAuthDB{clearCASEnabled: true}
	signer := newTestSigner(t)
	h := NewHandlers(db, signer, nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)

	req := httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	req, tok := withRefreshCookieToken(t, req, signer, user.ID)
	db.clearCASCurrent = &tok
	rec := httptest.NewRecorder()
	h.Logout(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}

	// What this test can actually see is that the handler issued the CLEAR
	// query for this user with the presented token.  Whether that statement
	// then nulls all three token columns is a property of the SQL, which no
	// fake can observe; that half is pinned in
	// test/integration/user_session_columns_test.go against a real Postgres.
	// Stated because the obvious reading of "logout was called" is that the
	// columns were checked, and they were not.
	if db.clearCallCount != 1 {
		t.Errorf("ClearRefreshTokenIfMatches called %d times, want 1", db.clearCallCount)
	}
	if db.clearCalledID != user.ID {
		t.Errorf("ClearRefreshTokenIfMatches id = %s, want %s", db.clearCalledID, user.ID)
	}

	// RotateRefreshToken must NOT have been called.
	if db.rotateRefreshCallCount != 0 {
		t.Errorf("RotateRefreshToken called %d times on logout, want 0", db.rotateRefreshCallCount)
	}
}

// TestLogout_StaleButSignedToken_ClearsNothing is the whole reason the write
// carries a predicate.
//
// A refresh token stays SIGNATURE-valid for its full 7-day TTL, including
// long after the server revoked it.  Without the predicate, replaying such a
// token against /logout nulls whatever session the row currently holds — so a
// dead credential from an old browser profile or a stale backup becomes a
// week-long forced-logout weapon aimed at one specific user, renewable every
// few minutes and costing the attacker one unauthenticated request.
//
// The caller's own cookies are still cleared: they asked to be logged out and
// they are, locally. What must not happen is the write reaching a session
// they no longer hold.
func TestLogout_StaleButSignedToken_ClearsNothing(t *testing.T) {
	t.Parallel()

	user := fixtureUser(t)
	signer := newTestSigner(t)

	// The row has moved on — the user logged in again elsewhere, so the live
	// token is not the one this request carries.
	live := "the-current-session-token"
	db := &fakeAuthDB{clearCASEnabled: true, clearCASCurrent: &live}
	h := NewHandlers(db, signer, nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)

	req := httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	req, stale := withRefreshCookieToken(t, req, signer, user.ID)
	rec := httptest.NewRecorder()
	h.Logout(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 — logout never reports whether it matched", rec.Code)
	}
	if db.clearCallCount != 1 {
		t.Fatalf("ClearRefreshTokenIfMatches called %d times, want 1", db.clearCallCount)
	}
	if db.clearCalledWith == nil || *db.clearCalledWith != stale {
		t.Errorf("the presented token must be passed to the predicate, got %v", db.clearCalledWith)
	}
	if db.clearCASCurrent == nil || *db.clearCASCurrent != live {
		t.Errorf("a stale token cleared the live session: %v", db.clearCASCurrent)
	}
	assertAuthCookiesCleared(t, rec)
}

// TestLogout_GraceSlotToken_StillClears keeps the predicate from being too
// tight.  A tab that refreshed moments ago holds the token that just moved
// into previous_refresh_token; it is a legitimate session and must be able to
// end itself.  Matching only refresh_token would 200-and-do-nothing for
// exactly the users who were most recently active.
func TestLogout_GraceSlotToken_StillClears(t *testing.T) {
	t.Parallel()

	user := fixtureUser(t)
	signer := newTestSigner(t)
	newer := "token-that-won-the-rotation"
	db := &fakeAuthDB{clearCASEnabled: true, clearCASCurrent: &newer}
	h := NewHandlers(db, signer, nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)

	req := httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	req, graceTok := withRefreshCookieToken(t, req, signer, user.ID)
	db.clearCASPrevious = &graceTok
	rec := httptest.NewRecorder()
	h.Logout(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if db.clearCASCurrent != nil || db.clearCASPrevious != nil {
		t.Errorf("a grace-slot token must still end the session; current=%v previous=%v",
			db.clearCASCurrent, db.clearCASPrevious)
	}
}

func TestUpdateMe_UpdatesPrivacyFlag(t *testing.T) {
	t.Parallel()

	user := fixtureUser(t)
	user.IsPublic = false
	db := &fakeAuthDB{
		getUserByID: func(_ context.Context, id uuid.UUID) (dbgen.User, error) {
			if id != user.ID {
				t.Fatalf("GetUserByID id = %s, want %s", id, user.ID)
			}
			return user, nil
		},
	}
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)

	req := httptest.NewRequest(http.MethodPatch, "/api/auth/me", bytes.NewBufferString(`{"isPublic":false}`))
	req = req.WithContext(injectClaims(req.Context(), user.ID, user.Username, user.Role))
	rec := httptest.NewRecorder()
	h.UpdateMe(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if db.setUserPublicCallCount != 1 || db.setUserPublicCalledID != user.ID || db.setUserPublicCalledVal {
		t.Fatalf("SetUserPublic calls=%d id=%s value=%v", db.setUserPublicCallCount, db.setUserPublicCalledID, db.setUserPublicCalledVal)
	}
	if !strings.Contains(rec.Body.String(), `"isPublic":false`) {
		t.Fatalf("response does not reflect privacy setting: %s", rec.Body.String())
	}
}

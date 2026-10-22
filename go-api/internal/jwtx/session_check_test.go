package jwtx

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeSessions is a SessionChecker that answers from its fields and records
// what it was asked.
type fakeSessions struct {
	live  bool
	err   error
	asked [][2]uuid.UUID // {sessionID, userID}
}

func (f *fakeSessions) SessionLive(_ context.Context, sessionID, userID uuid.UUID) (bool, error) {
	f.asked = append(f.asked, [2]uuid.UUID{sessionID, userID})
	return f.live, f.err
}

func signSessionAccess(t *testing.T, s *Signer, uid, sid uuid.UUID) string {
	t.Helper()
	tok, err := s.SignAccess(uid, sid, "alice", nil)
	require.NoError(t, err)
	return tok
}

// serve runs mw over a handler that reports whether it saw claims.
func serve(t *testing.T, mw func(http.Handler) http.Handler, token string) (*httptest.ResponseRecorder, *AccessClaims) {
	t.Helper()
	var seen *AccessClaims
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen, _ = ClaimsFrom(r.Context())
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec, seen
}

func errorCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	return body.Error.Code
}

func TestSignAccess_NamesItsSession(t *testing.T) {
	s := newMwSigner(t)
	uid, sid := uuid.New(), uuid.New()

	claims, err := s.VerifyAccess(signSessionAccess(t, s, uid, sid))

	require.NoError(t, err)
	assert.Equal(t, uid, claims.UserID)
	assert.Equal(t, sid, claims.SessionID)
}

func TestSignAccess_RefusesATokenWithoutASession(t *testing.T) {
	s := newMwSigner(t)

	_, err := s.SignAccess(uuid.New(), uuid.Nil, "alice", nil)

	assert.ErrorIs(t, err, ErrNoSession)
}

func TestRequireAuth_LiveSessionPasses(t *testing.T) {
	sessions := &fakeSessions{live: true}
	s := newMwSigner(t).WithSessionCheck(sessions)
	uid, sid := uuid.New(), uuid.New()

	rec, seen := serve(t, RequireAuth(s), signSessionAccess(t, s, uid, sid))

	assert.Equal(t, http.StatusOK, rec.Code)
	require.NotNil(t, seen)
	assert.Equal(t, sid, seen.SessionID)
	assert.Equal(t, [][2]uuid.UUID{{sid, uid}}, sessions.asked)
}

// The point of the check: a device signed out from another device's list,
// logged out, or ended by a password change holds an access token that still
// verifies for up to 15 minutes.  It must stop working on the next request.
func TestRequireAuth_EndedSessionIsRefusedAtOnce(t *testing.T) {
	s := newMwSigner(t).WithSessionCheck(&fakeSessions{live: false})

	rec, seen := serve(t, RequireAuth(s), signSessionAccess(t, s, uuid.New(), uuid.New()))

	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.Equal(t, codeInvalidToken, errorCode(t, rec))
	assert.Nil(t, seen, "the handler must not run")
}

// A failed lookup is not a verdict on the session: answering 401 would send
// the client to refresh and then to /login, signing everyone out whenever
// the database blinks (a deploy restarts it).
func TestRequireAuth_FailedCheckIsAServerError(t *testing.T) {
	s := newMwSigner(t).WithSessionCheck(&fakeSessions{err: errors.New("db down")})

	rec, seen := serve(t, RequireAuth(s), signSessionAccess(t, s, uuid.New(), uuid.New()))

	assert.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.Equal(t, "SERVER_ERROR", errorCode(t, rec))
	assert.Nil(t, seen)
}

// Access tokens minted before they named a session carry no sid.  They
// cannot be checked, and they run out on their own within the access TTL.
func TestRequireAuth_TokenWithoutSessionIsNotLookedUp(t *testing.T) {
	sessions := &fakeSessions{live: false}
	s := newMwSigner(t).WithSessionCheck(sessions)
	now := time.Now()
	legacy, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"userId":   uuid.New().String(),
		"username": "alice",
		"iat":      now.Unix(),
		"exp":      now.Add(time.Minute).Unix(),
	}).SignedString([]byte("mw-access-secret"))
	require.NoError(t, err)

	rec, seen := serve(t, RequireAuth(s), legacy)

	assert.Equal(t, http.StatusOK, rec.Code)
	require.NotNil(t, seen)
	assert.Equal(t, uuid.Nil, seen.SessionID)
	assert.Empty(t, sessions.asked)
}

func TestRequireAuth_SignerWithoutCheckerLooksNothingUp(t *testing.T) {
	s := newMwSigner(t)

	rec, _ := serve(t, RequireAuth(s), signSessionAccess(t, s, uuid.New(), uuid.New()))

	assert.Equal(t, http.StatusOK, rec.Code)
}

func TestOptionalAuth_EndedSessionIsAnonymous(t *testing.T) {
	s := newMwSigner(t).WithSessionCheck(&fakeSessions{live: false})

	rec, seen := serve(t, OptionalAuth(s), signSessionAccess(t, s, uuid.New(), uuid.New()))

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Nil(t, seen)
}

func TestOptionalAuth_FailedCheckIsAnonymous(t *testing.T) {
	s := newMwSigner(t).WithSessionCheck(&fakeSessions{err: errors.New("db down")})

	rec, seen := serve(t, OptionalAuth(s), signSessionAccess(t, s, uuid.New(), uuid.New()))

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Nil(t, seen)
}

func TestOptionalAuth_LiveSessionAttachesClaims(t *testing.T) {
	s := newMwSigner(t).WithSessionCheck(&fakeSessions{live: true})
	uid := uuid.New()

	_, seen := serve(t, OptionalAuth(s), signSessionAccess(t, s, uid, uuid.New()))

	require.NotNil(t, seen)
	assert.Equal(t, uid, seen.UserID)
}

func TestWithSessionCheck_LeavesTheOriginalSignerAlone(t *testing.T) {
	base := newMwSigner(t)
	sessions := &fakeSessions{live: false}
	_ = base.WithSessionCheck(sessions)

	rec, _ := serve(t, RequireAuth(base), signSessionAccess(t, base, uuid.New(), uuid.New()))

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Empty(t, sessions.asked)
}

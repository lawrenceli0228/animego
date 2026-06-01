package jwtx

// optional_auth_test.go — OptionalAuth middleware.
//
// Scenarios verified:
//   - Valid access token (header)    → claims injected into context, 200.
//   - Valid access token (cookie)    → claims injected into context, 200.
//   - No token at all                → request continues as anonymous (no claims).
//   - Invalid / garbage token        → request continues as anonymous (silent).
//   - Expired token                  → request continues as anonymous (silent).

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// newOptionalSigner constructs a Signer for OptionalAuth tests.
func newOptionalSigner(t *testing.T) *Signer {
	t.Helper()
	s, err := NewSigner("opt-access-secret", "opt-refresh-secret", 15*time.Minute, 7*24*time.Hour)
	require.NoError(t, err)
	return s
}

// anonymousHandler is an inner handler that checks whether claims are present
// and writes "anon" or the user ID accordingly.
func anonOrUserHandler(t *testing.T) http.Handler {
	t.Helper()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims, ok := ClaimsFrom(r.Context())
		if !ok || claims == nil {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("anon"))
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(claims.UserID.String()))
	})
}

func TestOptionalAuth_ValidHeaderToken_InjectsClaims(t *testing.T) {
	s := newOptionalSigner(t)
	userID := uuid.New()
	tok, err := s.SignAccess(userID, "alice", nil)
	require.NoError(t, err)

	handler := OptionalAuth(s)(anonOrUserHandler(t))
	req := httptest.NewRequest(http.MethodGet, "/api/users/alice", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, userID.String(), rec.Body.String())
}

func TestOptionalAuth_ValidCookieToken_InjectsClaims(t *testing.T) {
	s := newOptionalSigner(t)
	userID := uuid.New()
	tok, err := s.SignAccess(userID, "bob", nil)
	require.NoError(t, err)

	handler := OptionalAuth(s)(anonOrUserHandler(t))
	req := httptest.NewRequest(http.MethodGet, "/api/users/bob", nil)
	req.AddCookie(&http.Cookie{Name: AccessTokenCookieName, Value: tok})
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, userID.String(), rec.Body.String())
}

func TestOptionalAuth_NoToken_ContinuesAsAnon(t *testing.T) {
	s := newOptionalSigner(t)

	handler := OptionalAuth(s)(anonOrUserHandler(t))
	req := httptest.NewRequest(http.MethodGet, "/api/users/carol", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "anon", rec.Body.String())
}

func TestOptionalAuth_InvalidToken_ContinuesAsAnon(t *testing.T) {
	s := newOptionalSigner(t)

	handler := OptionalAuth(s)(anonOrUserHandler(t))
	req := httptest.NewRequest(http.MethodGet, "/api/users/dave", nil)
	req.Header.Set("Authorization", "Bearer totally.garbage.value")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	// No 401 — silently falls through as anon.
	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "anon", rec.Body.String())
}

func TestOptionalAuth_ExpiredToken_ContinuesAsAnon(t *testing.T) {
	// Build a signer with a negative TTL so tokens are born expired.
	expiredSigner, err := NewSigner("opt-access-secret", "opt-refresh-secret", -1*time.Second, time.Hour)
	require.NoError(t, err)
	tok, err := expiredSigner.SignAccess(uuid.New(), "expired-user", nil)
	require.NoError(t, err)

	// Verify with the normal signer (same secret, but the token exp < now).
	s := newOptionalSigner(t)
	handler := OptionalAuth(s)(anonOrUserHandler(t))

	req := httptest.NewRequest(http.MethodGet, "/api/users/expired-user", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "anon", rec.Body.String())
}

func TestOptionalAuth_InvalidCookieToken_ContinuesAsAnon(t *testing.T) {
	s := newOptionalSigner(t)

	handler := OptionalAuth(s)(anonOrUserHandler(t))
	req := httptest.NewRequest(http.MethodGet, "/api/users/frank", nil)
	req.AddCookie(&http.Cookie{Name: AccessTokenCookieName, Value: "bad.cookie.jwt"})
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "anon", rec.Body.String())
}

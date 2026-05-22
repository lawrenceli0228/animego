package jwtx

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// newProtectedHandler returns a handler that writes 200 + the userID
// from the context.  Tests assert both the status and that the claims
// were threaded through correctly.
func newProtectedHandler(t *testing.T) http.Handler {
	t.Helper()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims, ok := ClaimsFrom(r.Context())
		require.True(t, ok, "claims must be present in context")
		require.NotNil(t, claims)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(claims.UserID.String()))
	})
}

func newMwSigner(t *testing.T) *Signer {
	t.Helper()
	s, err := NewSigner("mw-access-secret", "mw-refresh-secret", 15*time.Minute, 7*24*time.Hour)
	require.NoError(t, err)
	return s
}

func TestRequireAuth_HeaderValid(t *testing.T) {
	s := newMwSigner(t)
	userID := uuid.New()
	tok, err := s.SignAccess(userID, "alice", nil)
	require.NoError(t, err)

	handler := RequireAuth(s)(newProtectedHandler(t))
	req := httptest.NewRequest(http.MethodGet, "/protected", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, userID.String(), rec.Body.String())
}

func TestRequireAuth_HeaderWins_OverBadCookie(t *testing.T) {
	s := newMwSigner(t)
	tok, err := s.SignAccess(uuid.New(), "bob", nil)
	require.NoError(t, err)

	handler := RequireAuth(s)(newProtectedHandler(t))
	req := httptest.NewRequest(http.MethodGet, "/protected", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	req.AddCookie(&http.Cookie{Name: AccessTokenCookieName, Value: "garbage-cookie-value"})
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code, "header should win over bad cookie")
}

func TestRequireAuth_CookieValid(t *testing.T) {
	s := newMwSigner(t)
	userID := uuid.New()
	tok, err := s.SignAccess(userID, "carol", nil)
	require.NoError(t, err)

	handler := RequireAuth(s)(newProtectedHandler(t))
	req := httptest.NewRequest(http.MethodGet, "/protected", nil)
	req.AddCookie(&http.Cookie{Name: AccessTokenCookieName, Value: tok})
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, userID.String(), rec.Body.String())
}

func TestRequireAuth_NoHeaderNoCookie_401_NoToken(t *testing.T) {
	s := newMwSigner(t)

	// Inner handler should NEVER be called.
	called := false
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true })

	handler := RequireAuth(s)(inner)
	req := httptest.NewRequest(http.MethodGet, "/protected", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.False(t, called, "inner handler must not be invoked on auth failure")
	assert.Contains(t, rec.Body.String(), `"NO_TOKEN"`)
	assert.Contains(t, rec.Body.String(), `"Authentication required"`)
}

func TestRequireAuth_BadHeader_401_InvalidToken(t *testing.T) {
	s := newMwSigner(t)

	handler := RequireAuth(s)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("inner handler must not run")
	}))
	req := httptest.NewRequest(http.MethodGet, "/protected", nil)
	req.Header.Set("Authorization", "Bearer total.garbage.value")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.Contains(t, rec.Body.String(), `"INVALID_TOKEN"`)
}

func TestRequireAuth_BadCookie_401_InvalidToken(t *testing.T) {
	s := newMwSigner(t)

	handler := RequireAuth(s)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("inner handler must not run")
	}))
	req := httptest.NewRequest(http.MethodGet, "/protected", nil)
	req.AddCookie(&http.Cookie{Name: AccessTokenCookieName, Value: "not.a.real.jwt"})
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.Contains(t, rec.Body.String(), `"INVALID_TOKEN"`)
}

func TestRequireAuth_HeaderNotBearer_FallsThroughToCookie(t *testing.T) {
	s := newMwSigner(t)
	tok, err := s.SignAccess(uuid.New(), "fallthrough", nil)
	require.NoError(t, err)

	handler := RequireAuth(s)(newProtectedHandler(t))
	req := httptest.NewRequest(http.MethodGet, "/protected", nil)
	req.Header.Set("Authorization", "Basic dXNlcjpwYXNz")
	req.AddCookie(&http.Cookie{Name: AccessTokenCookieName, Value: tok})
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code, "non-Bearer header must fall through to cookie")
}

func TestRequireAuth_EnvelopeShape_NoToken(t *testing.T) {
	s := newMwSigner(t)
	handler := RequireAuth(s)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	req := httptest.NewRequest(http.MethodGet, "/protected", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	resp := rec.Result()
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)

	expected := []byte(`{"error":{"code":"NO_TOKEN","message":"Authentication required"}}`)
	assert.True(t, bytes.Equal(body, expected),
		"envelope bytes mismatch\nwant: %s\n got: %s", expected, body)
	assert.Equal(t, "application/json; charset=utf-8", resp.Header.Get("Content-Type"))
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestRequireAuth_EnvelopeShape_InvalidToken(t *testing.T) {
	s := newMwSigner(t)
	handler := RequireAuth(s)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	req := httptest.NewRequest(http.MethodGet, "/protected", nil)
	req.Header.Set("Authorization", "Bearer bogus.token.value")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	resp := rec.Result()
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)

	expected := []byte(`{"error":{"code":"INVALID_TOKEN","message":"Invalid token"}}`)
	assert.True(t, bytes.Equal(body, expected),
		"envelope bytes mismatch\nwant: %s\n got: %s", expected, body)
}

func TestRequireAuth_ExpiredToken_InvalidToken(t *testing.T) {
	// Expired tokens collapse into INVALID_TOKEN — we deliberately
	// don't surface "expired" separately so attackers can't probe.
	expiredSigner, err := NewSigner("mw-access-secret", "mw-refresh-secret", -1*time.Second, time.Hour)
	require.NoError(t, err)
	tok, err := expiredSigner.SignAccess(uuid.New(), "expired", nil)
	require.NoError(t, err)

	verifier := newMwSigner(t) // same secret, so signature is valid but exp < now
	handler := RequireAuth(verifier)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("inner handler must not run")
	}))
	req := httptest.NewRequest(http.MethodGet, "/protected", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.Contains(t, rec.Body.String(), `"INVALID_TOKEN"`)
}

func TestClaimsFrom_NoContext(t *testing.T) {
	// Nil context → (nil, false), no panic.
	c, ok := ClaimsFrom(nil) //nolint:staticcheck // intentionally testing nil
	assert.Nil(t, c)
	assert.False(t, ok)

	// Empty context → (nil, false).
	c, ok = ClaimsFrom(context.Background())
	assert.Nil(t, c)
	assert.False(t, ok)
}

func TestClaimsFrom_WrongType(t *testing.T) {
	// Context has the right key but wrong value type — should return
	// (nil, false) instead of panicking on the type assertion.
	ctx := context.WithValue(context.Background(), claimsKey, "not-a-claims-pointer")
	c, ok := ClaimsFrom(ctx)
	assert.Nil(t, c)
	assert.False(t, ok)
}

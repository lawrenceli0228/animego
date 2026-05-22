package jwtx

// admin_test.go — RequireAdmin middleware coverage.
//
// What we verify:
//   - claims.Role == "admin" → next.ServeHTTP fired, status passes through.
//   - claims.Role == nil      → 403 + byte-exact body.
//   - claims.Role == "user"   → 403 + byte-exact body.
//   - no claims in context    → 403 (defense-in-depth, not 500).
//   - the marshaled body bytes equal the hand-written Express literal.

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
)

func TestRequireAdmin_AllowsAdminRole(t *testing.T) {
	role := "admin"
	claims := &AccessClaims{
		UserID:   uuid.New(),
		Username: "alice",
		Role:     &role,
	}

	called := false
	handler := RequireAdmin()(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/admin/stats", nil)
	req = req.WithContext(withClaims(req.Context(), claims))
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if !called {
		t.Fatalf("next handler not invoked for admin role")
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
}

func TestRequireAdmin_RejectsNilRole(t *testing.T) {
	claims := &AccessClaims{
		UserID:   uuid.New(),
		Username: "bob",
		Role:     nil, // regular user — Role omitted from JWT
	}
	assertForbidden(t, claims)
}

func TestRequireAdmin_RejectsNonAdminRole(t *testing.T) {
	role := "user"
	claims := &AccessClaims{
		UserID:   uuid.New(),
		Username: "carol",
		Role:     &role,
	}
	assertForbidden(t, claims)
}

func TestRequireAdmin_RejectsMissingClaims(t *testing.T) {
	// Caller forgot to mount RequireAuth in front — middleware should
	// still 403 rather than panic or 500.
	handler := RequireAdmin()(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Fatalf("next handler must not run when claims are absent")
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/admin/stats", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
	expectBody(t, rec, `{"error":{"code":"FORBIDDEN","message":"无权限"}}`)
}

func TestRequireAdmin_HandlesNilContext(t *testing.T) {
	// Defensive — context.Background() has no claims, must 403 cleanly.
	handler := RequireAdmin()(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		t.Fatal("must not run")
	}))
	req := httptest.NewRequest(http.MethodGet, "/", nil).WithContext(context.Background())
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
}

func TestForbiddenBody_ByteExact(t *testing.T) {
	// Phase 8.5 shadow-traffic guarantee: bytes match Express literal.
	expected := []byte(`{"error":{"code":"FORBIDDEN","message":"无权限"}}`)
	if !bytes.Equal(forbiddenBody, expected) {
		t.Fatalf("forbiddenBody = %q, want %q", forbiddenBody, expected)
	}
}

// ---------- helpers ----------

func assertForbidden(t *testing.T, claims *AccessClaims) {
	t.Helper()
	handler := RequireAdmin()(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		t.Fatalf("next handler must not run for non-admin role")
	}))
	req := httptest.NewRequest(http.MethodGet, "/api/admin/stats", nil)
	req = req.WithContext(withClaims(req.Context(), claims))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type = %q, want application/json; charset=utf-8", got)
	}
	expectBody(t, rec, `{"error":{"code":"FORBIDDEN","message":"无权限"}}`)
}

func expectBody(t *testing.T, rec *httptest.ResponseRecorder, want string) {
	t.Helper()
	got := rec.Body.String()
	if got != want {
		t.Fatalf("body = %q, want %q", got, want)
	}
}

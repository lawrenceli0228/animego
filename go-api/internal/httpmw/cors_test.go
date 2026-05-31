package httpmw

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCORS_PreflightAllowedOrigin(t *testing.T) {
	t.Parallel()

	mw := CORS("http://localhost:3000")
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("preflight should not reach inner handler")
	}))

	req := httptest.NewRequest(http.MethodOptions, "/api/anime", nil)
	req.Header.Set("Origin", "http://localhost:3000")
	req.Header.Set("Access-Control-Request-Method", "POST")
	req.Header.Set("Access-Control-Request-Headers", "Authorization, Content-Type")

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK && rec.Code != http.StatusNoContent {
		t.Errorf("preflight status = %d, want 200 or 204", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "http://localhost:3000" {
		t.Errorf("Allow-Origin = %q, want http://localhost:3000", got)
	}
	if got := rec.Header().Get("Access-Control-Allow-Credentials"); got != "true" {
		t.Errorf("Allow-Credentials = %q, want true (cookie auth requires it)", got)
	}
	if got := rec.Header().Get("Access-Control-Max-Age"); got != "300" {
		t.Errorf("Max-Age = %q, want 300", got)
	}
}

func TestCORS_PreflightRejectsForeignOrigin(t *testing.T) {
	t.Parallel()

	mw := CORS("http://localhost:3000")
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))

	req := httptest.NewRequest(http.MethodOptions, "/api/anime", nil)
	req.Header.Set("Origin", "http://evil.example")
	req.Header.Set("Access-Control-Request-Method", "POST")

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("foreign Origin should not get Allow-Origin header, got %q", got)
	}
}

func TestCORS_SimpleGetPassesThrough(t *testing.T) {
	t.Parallel()

	mw := CORS("http://localhost:3000")
	called := false
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"data":{}}`))
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/anime", nil)
	req.Header.Set("Origin", "http://localhost:3000")

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if !called {
		t.Errorf("inner handler not called for non-preflight request")
	}
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "http://localhost:3000" {
		t.Errorf("Allow-Origin = %q on simple GET", got)
	}
}

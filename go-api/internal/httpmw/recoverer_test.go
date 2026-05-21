package httpmw

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5/middleware"
)

func TestRecoverer_HandlerPanic(t *testing.T) {
	t.Parallel()

	var buf bytes.Buffer
	mw := Recoverer(captureLogger(&buf))
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("boom: index out of range")
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/anime/123", nil)
	ctx := context.WithValue(req.Context(), middleware.RequestIDKey, "req-xyz")
	req = req.WithContext(ctx)

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
	want := `{"error":{"code":"SERVER_ERROR","message":"internal error"}}`
	if got := rec.Body.String(); got != want {
		t.Errorf("body = %q, want %q", got, want)
	}

	// Log must contain panic value + stack + request_id.
	r := firstRecord(t, &buf)
	if r["msg"] != "handler panic" {
		t.Errorf("msg = %v, want \"handler panic\"", r["msg"])
	}
	if !strings.Contains(r["panic"].(string), "boom") {
		t.Errorf("panic field missing message: %v", r["panic"])
	}
	if r["request_id"] != "req-xyz" {
		t.Errorf("request_id = %v", r["request_id"])
	}
	if !strings.Contains(r["stack"].(string), "recoverer_test.go") {
		t.Errorf("stack missing source location: %v", r["stack"])
	}
	if r["level"] != "ERROR" {
		t.Errorf("level = %v, want ERROR", r["level"])
	}
}

func TestRecoverer_PanicWithError(t *testing.T) {
	t.Parallel()

	var buf bytes.Buffer
	mw := Recoverer(captureLogger(&buf))
	rootErr := errors.New("nil pointer deref")
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic(rootErr)
	}))

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/x", nil))

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
	r := firstRecord(t, &buf)
	if !strings.Contains(r["panic"].(string), "nil pointer deref") {
		t.Errorf("panic field = %v", r["panic"])
	}
}

func TestRecoverer_NoPanicPassesThrough(t *testing.T) {
	t.Parallel()

	var buf bytes.Buffer
	mw := Recoverer(captureLogger(&buf))
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"data":{"ok":true}}`))
	}))

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/x", nil))

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rec.Code)
	}
	if got := rec.Body.String(); got != `{"data":{"ok":true}}` {
		t.Errorf("body = %q", got)
	}
	if buf.Len() != 0 {
		t.Errorf("expected no log on happy path, got %q", buf.String())
	}
}

func TestRecoverer_AbortHandlerReraises(t *testing.T) {
	t.Parallel()

	// net/http documents http.ErrAbortHandler as the "give up cleanly"
	// signal — middleware must re-panic so net/http closes the
	// connection without writing a body.  If Recoverer swallowed it,
	// the abort semantics would be lost.
	defer func() {
		if rec := recover(); rec != http.ErrAbortHandler {
			t.Errorf("expected re-panic of http.ErrAbortHandler, got %v", rec)
		}
	}()

	var buf bytes.Buffer
	mw := Recoverer(captureLogger(&buf))
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic(http.ErrAbortHandler)
	}))
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/x", nil))
}

func TestRecoverer_NilLoggerFallback(t *testing.T) {
	t.Parallel()

	// Must not panic when constructed with nil logger.  Use the panic
	// path so we exercise both the nil-check and the inner LogAttrs.
	mw := Recoverer(nil)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("test")
	}))

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/x", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
}

package httpmw

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMaxBodyBytes_NilBodyPassesThrough(t *testing.T) {
	t.Parallel()
	// GET requests typically have no body — middleware should not wrap nil
	// and must forward the request to the next handler.
	var called bool
	handler := MaxBodyBytes(DefaultMaxBodyBytes)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		if r.Body != nil && r.Body != http.NoBody {
			t.Error("expected nil/NoBody to remain unwrapped")
		}
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/anime/1", nil)
	// httptest.NewRequest sets Body to http.NoBody for no-body methods.
	handler.ServeHTTP(httptest.NewRecorder(), req)
	if !called {
		t.Error("inner handler was not called")
	}
}

func TestMaxBodyBytes_SmallBodyPassesThrough(t *testing.T) {
	t.Parallel()
	// A body well within the limit should be readable in full.
	payload := `{"username":"alice","password":"s3cr3t"}`
	handler := MaxBodyBytes(DefaultMaxBodyBytes)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("unexpected body read error: %v", err)
		}
		if string(b) != payload {
			t.Errorf("body = %q, want %q", b, payload)
		}
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rec.Code)
	}
}

func TestMaxBodyBytes_BodyOverLimitReturnsError(t *testing.T) {
	t.Parallel()
	// A body larger than the cap must cause Read to fail with MaxBytesError.
	const limit = 16 // intentionally tiny for the test
	oversizedPayload := strings.Repeat("x", limit+1)

	var readErr error
	handler := MaxBodyBytes(int64(limit))(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, readErr = io.ReadAll(r.Body)
		// We DON'T assert on status here — handler behaviour after
		// body-read failure is up to the downstream handler.
		w.WriteHeader(http.StatusBadRequest)
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/auth/register", strings.NewReader(oversizedPayload))
	req.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(httptest.NewRecorder(), req)

	if readErr == nil {
		t.Error("expected a read error for oversized body, got nil")
	}
}

func TestMaxBodyBytes_ExactLimitPassesThrough(t *testing.T) {
	t.Parallel()
	// Exactly `limit` bytes should NOT produce an error.
	const limit = 8
	payload := strings.Repeat("a", limit)

	handler := MaxBodyBytes(int64(limit))(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("unexpected body read error at exact limit: %v", err)
		}
		if len(b) != limit {
			t.Errorf("body len = %d, want %d", len(b), limit)
		}
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(payload))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rec.Code)
	}
}

package httpmw

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5/middleware"
)

// captureLogger returns a logger that writes JSON records to buf.
func captureLogger(buf *bytes.Buffer) *slog.Logger {
	return slog.New(slog.NewJSONHandler(buf, &slog.HandlerOptions{
		Level: slog.LevelDebug,
	}))
}

// firstRecord parses buf as one or more newline-delimited JSON records and
// returns the first one as a map.  Fails the test if no records exist.
func firstRecord(t *testing.T, buf *bytes.Buffer) map[string]any {
	t.Helper()
	if buf.Len() == 0 {
		t.Fatalf("expected slog record, buffer empty")
	}
	lines := strings.Split(strings.TrimRight(buf.String(), "\n"), "\n")
	if len(lines) == 0 {
		t.Fatalf("no log records in buffer: %q", buf.String())
	}
	var rec map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &rec); err != nil {
		t.Fatalf("unmarshal slog record: %v\nraw: %s", err, lines[0])
	}
	return rec
}

func TestRequestLog_HappyPath(t *testing.T) {
	t.Parallel()

	var buf bytes.Buffer
	mw := RequestLog(captureLogger(&buf))
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"data":{}}`))
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/anime", nil)
	req.RemoteAddr = "10.0.0.1:54321"
	ctx := context.WithValue(req.Context(), middleware.RequestIDKey, "req-abc")
	req = req.WithContext(ctx)

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Errorf("status = %d, want 201", rec.Code)
	}
	r := firstRecord(t, &buf)
	if r["msg"] != "http" {
		t.Errorf("msg = %v, want \"http\"", r["msg"])
	}
	if r["method"] != "POST" {
		t.Errorf("method = %v", r["method"])
	}
	if r["path"] != "/api/anime" {
		t.Errorf("path = %v", r["path"])
	}
	if int(r["status"].(float64)) != 201 {
		t.Errorf("status = %v, want 201", r["status"])
	}
	if int(r["bytes"].(float64)) != len(`{"data":{}}`) {
		t.Errorf("bytes = %v, want %d", r["bytes"], len(`{"data":{}}`))
	}
	if r["request_id"] != "req-abc" {
		t.Errorf("request_id = %v", r["request_id"])
	}
	if r["client_ip"] != "10.0.0.1" {
		t.Errorf("client_ip = %v, want 10.0.0.1", r["client_ip"])
	}
	if r["level"] != "INFO" {
		t.Errorf("level = %v, want INFO for 201", r["level"])
	}
}

func TestRequestLog_LevelMapping(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name      string
		status    int
		wantLevel string
	}{
		{"200 → INFO", http.StatusOK, "INFO"},
		{"201 → INFO", http.StatusCreated, "INFO"},
		{"301 → INFO", http.StatusMovedPermanently, "INFO"},
		{"400 → WARN", http.StatusBadRequest, "WARN"},
		{"404 → WARN", http.StatusNotFound, "WARN"},
		{"499 → WARN", 499, "WARN"},
		{"500 → ERROR", http.StatusInternalServerError, "ERROR"},
		{"503 → ERROR", http.StatusServiceUnavailable, "ERROR"},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			var buf bytes.Buffer
			mw := RequestLog(captureLogger(&buf))
			handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
			}))
			req := httptest.NewRequest(http.MethodGet, "/x", nil)
			handler.ServeHTTP(httptest.NewRecorder(), req)

			r := firstRecord(t, &buf)
			if r["level"] != tc.wantLevel {
				t.Errorf("status %d: level = %v, want %s", tc.status, r["level"], tc.wantLevel)
			}
		})
	}
}

func TestRequestLog_HealthSkipped(t *testing.T) {
	t.Parallel()

	// Docker healthcheck hits /health every 30s — middleware must NOT
	// emit a log record for it.
	var buf bytes.Buffer
	mw := RequestLog(captureLogger(&buf))
	called := false
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	handler.ServeHTTP(httptest.NewRecorder(), req)

	if !called {
		t.Errorf("handler not called — middleware should pass through")
	}
	if buf.Len() != 0 {
		t.Errorf("/health emitted log record (should skip): %s", buf.String())
	}
}

func TestRequestLog_ImplicitStatusOK(t *testing.T) {
	t.Parallel()

	// Handler that writes body without WriteHeader — net/http promotes
	// it to 200 on flush.  Middleware must record 200, not 0.
	var buf bytes.Buffer
	mw := RequestLog(captureLogger(&buf))
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("hello"))
	}))

	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	handler.ServeHTTP(httptest.NewRecorder(), req)

	r := firstRecord(t, &buf)
	if int(r["status"].(float64)) != 200 {
		t.Errorf("status = %v, want 200 (implicit)", r["status"])
	}
}

func TestRequestLog_NilLoggerFallback(t *testing.T) {
	t.Parallel()

	// Defensive: passing nil should not panic — fall back to slog.Default().
	mw := RequestLog(nil)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/x", nil))
}

func TestClientIP_StripsPort(t *testing.T) {
	t.Parallel()

	cases := []struct {
		in, want string
	}{
		{"10.0.0.1:54321", "10.0.0.1"},
		{"[::1]:8080", "[::1]"},
		{"", ""},
		{"no-port", "no-port"},
	}
	for _, tc := range cases {
		req := httptest.NewRequest(http.MethodGet, "/x", nil)
		req.RemoteAddr = tc.in
		if got := clientIP(req); got != tc.want {
			t.Errorf("clientIP(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

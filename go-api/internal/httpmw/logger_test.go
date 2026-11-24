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
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/lawrenceli0228/animego/go-api/internal/obs"
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

// TestClassifyStatus pins the one decision that keeps a client hanging up
// from being reported as a server fault: only a 5xx answered to a request
// whose client is gone, and only when it came back quickly, is logged as 499.
func TestClassifyStatus(t *testing.T) {
	t.Parallel()

	const quick = 20 * time.Millisecond

	cases := []struct {
		name       string
		status     int
		clientGone bool
		dur        time.Duration
		wantStatus int
		wantLevel  slog.Level
	}{
		{"500, client still there → 500 ERROR", http.StatusInternalServerError, false, quick, http.StatusInternalServerError, slog.LevelError},
		{"500, client gone, quick → 499 WARN", http.StatusInternalServerError, true, quick, 499, slog.LevelWarn},
		{"500, client gone, just under 5s → 499 WARN", http.StatusInternalServerError, true, 5*time.Second - time.Millisecond, 499, slog.LevelWarn},
		{"500, client gone, exactly 5s → 500 ERROR", http.StatusInternalServerError, true, 5 * time.Second, http.StatusInternalServerError, slog.LevelError},
		{"500, client gone, slow → 500 ERROR", http.StatusInternalServerError, true, 30 * time.Second, http.StatusInternalServerError, slog.LevelError},
		{"503, client gone, quick → 499 WARN", http.StatusServiceUnavailable, true, quick, 499, slog.LevelWarn},
		{"200, client gone → 200 INFO", http.StatusOK, true, quick, http.StatusOK, slog.LevelInfo},
		{"404, client still there → 404 WARN", http.StatusNotFound, false, quick, http.StatusNotFound, slog.LevelWarn},
		{"404, client gone → 404 WARN", http.StatusNotFound, true, quick, http.StatusNotFound, slog.LevelWarn},
		{"200, client still there → 200 INFO", http.StatusOK, false, quick, http.StatusOK, slog.LevelInfo},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			gotStatus, gotLevel := classifyStatus(tc.status, tc.clientGone, tc.dur)
			if gotStatus != tc.wantStatus || gotLevel != tc.wantLevel {
				t.Errorf("classifyStatus(%d, %v, %v) = (%d, %v), want (%d, %v)",
					tc.status, tc.clientGone, tc.dur, gotStatus, gotLevel, tc.wantStatus, tc.wantLevel)
			}
		})
	}
}

// TestRequestLog_ClientGoneServerErrorIsLogged499 drives the rule through the
// middleware: the client hangs up, then the handler answers 500.  The log
// says 499 at WARN (so it never reaches Sentry) and carries no group key; the
// response itself is left alone.
func TestRequestLog_ClientGoneServerErrorIsLogged499(t *testing.T) {
	t.Parallel()

	var buf bytes.Buffer
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	handler := RequestLog(captureLogger(&buf))(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cancel() // net/http does this when the connection closes
		w.WriteHeader(http.StatusInternalServerError)
	}))

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/x/1", nil).WithContext(ctx))

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("response status = %d, want 500 (only the log is reclassified)", rec.Code)
	}
	r := firstRecord(t, &buf)
	if int(r["status"].(float64)) != 499 {
		t.Errorf("logged status = %v, want 499", r["status"])
	}
	if r["level"] != "WARN" {
		t.Errorf("level = %v, want WARN", r["level"])
	}
	if r["msg"] != "http" {
		t.Errorf("msg = %v, want \"http\"", r["msg"])
	}
	if _, ok := r[obs.SentryGroupAttr]; ok {
		t.Errorf("WARN record carries %s = %v, want absent", obs.SentryGroupAttr, r[obs.SentryGroupAttr])
	}
}

// TestRequestLog_DeadlineIsNotClientGone pins that only context.Canceled
// counts as the client leaving.  A deadline is the server giving up, and a
// 500 after it is still a server error.
func TestRequestLog_DeadlineIsNotClientGone(t *testing.T) {
	t.Parallel()

	var buf bytes.Buffer
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()

	handler := RequestLog(captureLogger(&buf))(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/x", nil).WithContext(ctx))

	r := firstRecord(t, &buf)
	if int(r["status"].(float64)) != http.StatusInternalServerError {
		t.Errorf("logged status = %v, want 500", r["status"])
	}
	if r["level"] != "ERROR" {
		t.Errorf("level = %v, want ERROR", r["level"])
	}
}

// serveThroughChi mounts RequestLog on a real chi router the way
// cmd/server/main.go does (r.Use), lets build register routes, and serves one
// request.  It returns the single log record.
func serveThroughChi(t *testing.T, method, target string, build func(r chi.Router)) map[string]any {
	t.Helper()

	var buf bytes.Buffer
	router := chi.NewRouter()
	router.Use(RequestLog(captureLogger(&buf)))
	build(router)

	router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(method, target, nil))
	return firstRecord(t, &buf)
}

func writeStatus(code int) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(code) }
}

// TestRequestLog_SentryGroupNamesRoutePattern is why the group exists: every
// 500 used to share one Sentry title, so a fault in one route hid behind all
// the others.  The value names the route pattern, not the concrete URL, so
// /api/x/123 and /api/x/456 land in the same issue.
func TestRequestLog_SentryGroupNamesRoutePattern(t *testing.T) {
	t.Parallel()

	r := serveThroughChi(t, http.MethodGet, "/api/x/123", func(r chi.Router) {
		r.Get("/api/x/{id}", writeStatus(http.StatusInternalServerError))
	})

	if r["level"] != "ERROR" {
		t.Errorf("level = %v, want ERROR", r["level"])
	}
	if r["msg"] != "http" {
		t.Errorf("msg = %v, want \"http\" (stdout message is unchanged)", r["msg"])
	}
	if r["path"] != "/api/x/123" {
		t.Errorf("path = %v, want the concrete path /api/x/123", r["path"])
	}
	if got := r[obs.SentryGroupAttr]; got != "500 GET /api/x/{id}" {
		t.Errorf("%s = %v, want %q", obs.SentryGroupAttr, got, "500 GET /api/x/{id}")
	}
}

// TestRequestLog_SentryGroupInsideMountedRouter covers the shape main.go uses
// everywhere (r.Route), where chi joins the mount pattern and the sub-route.
func TestRequestLog_SentryGroupInsideMountedRouter(t *testing.T) {
	t.Parallel()

	r := serveThroughChi(t, http.MethodPost, "/api/y/42/sub", func(r chi.Router) {
		r.Route("/api/y", func(r chi.Router) {
			r.Post("/{id}/sub", writeStatus(http.StatusBadGateway))
		})
	})

	if got := r[obs.SentryGroupAttr]; got != "502 POST /api/y/{id}/sub" {
		t.Errorf("%s = %v, want %q", obs.SentryGroupAttr, got, "502 POST /api/y/{id}/sub")
	}
}

// TestRequestLog_SentryGroupUnmatched: a path no route matches has no
// pattern.  chi leaves RoutePattern() empty for a top-level NotFound, and the
// group falls back to "unmatched".
func TestRequestLog_SentryGroupUnmatched(t *testing.T) {
	t.Parallel()

	r := serveThroughChi(t, http.MethodGet, "/nope/123", func(r chi.Router) {
		r.NotFound(writeStatus(http.StatusInternalServerError))
		r.Get("/api/x/{id}", writeStatus(http.StatusOK))
	})

	if r["level"] != "ERROR" {
		t.Errorf("level = %v, want ERROR", r["level"])
	}
	if got := r[obs.SentryGroupAttr]; got != "500 GET unmatched" {
		t.Errorf("%s = %v, want %q", obs.SentryGroupAttr, got, "500 GET unmatched")
	}
}

// TestRequestLog_SentryGroupUnmatchedInsideMount records what chi actually
// reports when the miss happens inside a mounted router: the mount pattern
// has already been recorded, so the group names the mount, not "unmatched".
func TestRequestLog_SentryGroupUnmatchedInsideMount(t *testing.T) {
	t.Parallel()

	r := serveThroughChi(t, http.MethodGet, "/api/y/nope/deeper", func(r chi.Router) {
		r.NotFound(writeStatus(http.StatusInternalServerError))
		r.Route("/api/y", func(r chi.Router) {
			r.Get("/{id}/sub", writeStatus(http.StatusOK))
		})
	})

	if got := r[obs.SentryGroupAttr]; got != "500 GET /api/y/*" {
		t.Errorf("%s = %v, want %q", obs.SentryGroupAttr, got, "500 GET /api/y/*")
	}
}

// TestRequestLog_SentryGroupOnlyOnErrors: a WARN or INFO record is never
// forwarded, so it does not carry the group key.
func TestRequestLog_SentryGroupOnlyOnErrors(t *testing.T) {
	t.Parallel()

	cases := []struct {
		code      int
		wantLevel string
	}{
		{http.StatusNotFound, "WARN"},
		{http.StatusOK, "INFO"},
	}
	for _, tc := range cases {
		r := serveThroughChi(t, http.MethodGet, "/api/z", func(r chi.Router) {
			r.Get("/api/z", writeStatus(tc.code))
		})
		if r["level"] != tc.wantLevel {
			t.Errorf("status %d: level = %v, want %s", tc.code, r["level"], tc.wantLevel)
		}
		if _, ok := r[obs.SentryGroupAttr]; ok {
			t.Errorf("status %d: record carries %s = %v, want absent", tc.code, obs.SentryGroupAttr, r[obs.SentryGroupAttr])
		}
	}
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

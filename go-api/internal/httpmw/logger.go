// Package httpmw provides HTTP middleware shared across go-api handlers.
//
// The package is named httpmw (not "middleware") to avoid colliding with
// github.com/go-chi/chi/v5/middleware, which every handler file imports for
// chi.NewWrapResponseWriter and middleware.RequestID.
//
// Middleware chain installed by cmd/server/main.go (locked by /plan-eng-review):
//
//	CORS  → RequestID  → RealIP  → RequestLog  → Recoverer  → Timeout
//
// Reasoning:
//   - CORS outermost: OPTIONS preflight returns early without touching the
//     rest of the chain.  Preflight doesn't need request_id tracking.
//   - RequestID before RequestLog so log records carry a stable id.
//   - Recoverer after RequestLog so a panic still produces a log line with
//     the wrapped status (500).
//   - Timeout innermost so it only bounds business handlers.
package httpmw

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5/middleware"
)

// healthPath is matched verbatim to skip log emission.  Docker healthcheck
// hits /health every 30s — 2880 log lines per pod per day is pure noise.
// Health failures still surface via the response body + docker restart;
// they do not need RequestLog coverage.
const healthPath = "/health"

// RequestLog returns a chi-compatible middleware that emits one structured
// slog record per non-/health request.  The record carries enough fields
// to debug a single request from prod logs without correlating across
// other systems:
//
//	method, path, status, bytes, duration_ms, request_id, client_ip
//
// Level mapping:
//
//	5xx → slog.LevelError   (alerting threshold)
//	4xx → slog.LevelWarn    (client errors but not paging)
//	otherwise → slog.LevelInfo
//
// The logger argument lets callers inject a logger with extra base fields
// (service name, build hash, etc.).  Pass slog.Default() for the standard
// process-wide JSON logger.
func RequestLog(logger *slog.Logger) func(next http.Handler) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			if req.URL.Path == healthPath {
				next.ServeHTTP(w, req)
				return
			}

			start := time.Now()
			ww := middleware.NewWrapResponseWriter(w, req.ProtoMajor)
			next.ServeHTTP(ww, req)
			dur := time.Since(start)

			status := ww.Status()
			if status == 0 {
				// Handler wrote no header.  Net/http will emit 200 on
				// implicit flush — record that for log consistency.
				status = http.StatusOK
			}

			lvl := slog.LevelInfo
			switch {
			case status >= 500:
				lvl = slog.LevelError
			case status >= 400:
				lvl = slog.LevelWarn
			}

			logger.LogAttrs(req.Context(), lvl, "http",
				slog.String("method", req.Method),
				slog.String("path", req.URL.Path),
				slog.Int("status", status),
				slog.Int("bytes", ww.BytesWritten()),
				slog.Int64("duration_ms", dur.Milliseconds()),
				slog.String("request_id", middleware.GetReqID(req.Context())),
				slog.String("client_ip", clientIP(req)),
			)
		})
	}
}

// clientIP returns the request's effective client IP.  chi's RealIP
// middleware sets r.RemoteAddr from X-Forwarded-For when present, so this
// is the single source of truth as long as RealIP runs before RequestLog.
func clientIP(req *http.Request) string {
	// RemoteAddr may include a port — strip it if present.
	addr := req.RemoteAddr
	for i := len(addr) - 1; i >= 0; i-- {
		if addr[i] == ':' {
			return addr[:i]
		}
	}
	return addr
}

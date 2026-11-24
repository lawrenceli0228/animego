// Package httpmw provides HTTP middleware shared across go-api handlers.
//
// The package is named httpmw (not "middleware") to avoid colliding with
// github.com/go-chi/chi/v5/middleware, which every handler file imports for
// chi.NewWrapResponseWriter and middleware.RequestID.
//
// Middleware chain installed by cmd/server/main.go, outermost first:
//
//	CORS → RequestID → RealIP → RequestLog → Recoverer → sentryhttp
//	     → Timeout → MaxBodyBytes → API rate limit → activity
//
// plus r.NotFound / r.MethodNotAllowed, which answer unmatched routes with
// the JSON envelope.
//
// Reasoning:
//   - CORS outermost: OPTIONS preflight returns early without touching the
//     rest of the chain.  Preflight doesn't need request_id tracking.
//   - RequestID before RequestLog so log records carry a stable id.
//   - RealIP before RequestLog so client_ip is the forwarded address.
//   - Recoverer after RequestLog so a panic still produces a log line with
//     the wrapped status (500).
//   - sentryhttp after Recoverer: it re-panics (Repanic: true) after
//     capturing, and Recoverer, being outer, turns that into the JSON 500.
//   - RequestLog outside Timeout: the request context RequestLog sees is
//     canceled only when the client goes away, never by the 60s deadline.
//     RequestLog's client-gone rule depends on that.
//   - Timeout before the body cap, rate limiter and presence recording, so
//     it bounds everything that does work for the request.
package httpmw

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/lawrenceli0228/animego/go-api/internal/obs"
)

// healthPath is matched verbatim to skip log emission.  Docker healthcheck
// hits /health every 30s — 2880 log lines per pod per day is pure noise.
// Health failures still surface via the response body + docker restart;
// they do not need RequestLog coverage.
const healthPath = "/health"

const (
	// statusClientClosedRequest is the status logged in place of a 5xx when
	// the client had already gone (nginx's 499 convention).  It is a log
	// value only; the response status is never changed.
	statusClientClosedRequest = 499

	// clientGoneMaxDuration bounds the client-gone rule.  A 5xx for a client
	// that left is logged as 499 only when the whole request was handled in
	// less than this.  The duration is total handling time — from RequestLog
	// entry to the handler returning — because when the client left is not
	// observable here.  A request that ran this long before failing is slow
	// enough to be a server problem whatever the client did.
	clientGoneMaxDuration = 5 * time.Second

	// unmatchedRoute stands in for the route pattern when chi recorded none
	// (no route context, or a miss at the top-level router).
	unmatchedRoute = "unmatched"
)

// RequestLog returns a chi-compatible middleware that emits one structured
// slog record per non-/health request.  The record carries enough fields
// to debug a single request from prod logs without correlating across
// other systems:
//
//	method, path, status, bytes, duration_ms, request_id, client_ip
//
// Level mapping (see classifyStatus):
//
//	5xx → slog.LevelError   (alerting threshold; forwarded to Sentry)
//	4xx → slog.LevelWarn    (client errors but not paging)
//	otherwise → slog.LevelInfo
//
// except that a 5xx answered after the client went away (request context
// canceled) within clientGoneMaxDuration is logged as status 499 at WARN.
// The handler wrote it because its work was canceled, not because the
// server failed.  The response itself still carries the handler's status.
//
// A record at ERROR also carries obs.SentryGroupAttr =
// "<status> <METHOD> <route pattern>", e.g. "500 GET /api/anime/{anilistId}",
// so Sentry files each route's failures as a separate issue.  The pattern is
// chi's, read after routing; a request no route matched uses "unmatched".
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
			clientGone := errors.Is(req.Context().Err(), context.Canceled)

			status := ww.Status()
			if status == 0 {
				// Handler wrote no header.  Net/http will emit 200 on
				// implicit flush — record that for log consistency.
				status = http.StatusOK
			}

			status, lvl := classifyStatus(status, clientGone, dur)

			attrs := []slog.Attr{
				slog.String("method", req.Method),
				slog.String("path", req.URL.Path),
				slog.Int("status", status),
				slog.Int("bytes", ww.BytesWritten()),
				slog.Int64("duration_ms", dur.Milliseconds()),
				slog.String("request_id", middleware.GetReqID(req.Context())),
				slog.String("client_ip", clientIP(req)),
			}
			if lvl >= slog.LevelError {
				attrs = append(attrs, slog.String(obs.SentryGroupAttr, sentryGroup(req, status)))
			}

			logger.LogAttrs(req.Context(), lvl, "http", attrs...)
		})
	}
}

// classifyStatus decides the status RequestLog records and the level it
// records it at.  clientGone reports that the request context was canceled
// by the time the handler returned; dur is the total handling time.
//
// A 5xx for a client that is gone, handled in under clientGoneMaxDuration,
// becomes statusClientClosedRequest.  Everything else keeps its status, and
// the level follows the (possibly rewritten) status: 5xx ERROR, 4xx WARN,
// else INFO.
func classifyStatus(status int, clientGone bool, dur time.Duration) (int, slog.Level) {
	if status >= 500 && clientGone && dur < clientGoneMaxDuration {
		status = statusClientClosedRequest
	}
	switch {
	case status >= 500:
		return status, slog.LevelError
	case status >= 400:
		return status, slog.LevelWarn
	default:
		return status, slog.LevelInfo
	}
}

// sentryGroup builds the obs.SentryGroupAttr value for an ERROR record.
//
// It must run after next.ServeHTTP has returned: chi fills in the route
// patterns while routing, and recycles the route context once the outer
// router's ServeHTTP returns.
func sentryGroup(req *http.Request, status int) string {
	pattern := ""
	if rctx := chi.RouteContext(req.Context()); rctx != nil {
		pattern = rctx.RoutePattern()
	}
	if pattern == "" {
		pattern = unmatchedRoute
	}
	return strconv.Itoa(status) + " " + req.Method + " " + pattern
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

package httpmw

import (
	"log/slog"
	"net/http"
	"runtime/debug"

	"github.com/go-chi/chi/v5/middleware"

	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
)

// Recoverer returns a chi-compatible middleware that catches handler panics
// and turns them into a 500 envelope response.
//
// Replaces chi/middleware.Recoverer, which writes a plain-text body —
// incompatible with the JSON envelope contract that Phase 8.5 shadow
// traffic diffs against Express.  The chi version also panics again when
// a handler that already wrote part of the response panics, which can
// drop request_id from the log line.
//
// The stack trace is logged at Error level along with the request id and
// the panic value.  The client receives only the canonical SERVER_ERROR
// envelope with no internal detail.
func Recoverer(logger *slog.Logger) func(next http.Handler) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			defer func() {
				rec := recover()
				if rec == nil {
					return
				}
				// http.ErrAbortHandler is the documented escape hatch
				// for handlers that want to give up cleanly without an
				// error response.  Honour it by re-panicking so net/http
				// can close the connection without a log line.
				if rec == http.ErrAbortHandler {
					panic(rec)
				}

				stack := debug.Stack()
				logger.LogAttrs(req.Context(), slog.LevelError, "handler panic",
					slog.Any("panic", rec),
					slog.String("path", req.URL.Path),
					slog.String("method", req.Method),
					slog.String("request_id", middleware.GetReqID(req.Context())),
					slog.String("stack", string(stack)),
				)

				httpx.Fail(w, httpx.NewError(
					http.StatusInternalServerError,
					httpx.CodeServerError,
					"internal error",
				))
			}()
			next.ServeHTTP(w, req)
		})
	}
}

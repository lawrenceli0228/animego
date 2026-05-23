package httpmw

// notfound.go — chi NotFound + MethodNotAllowed handlers that emit the
// canonical httpx error envelope.  Express's catch-all at
// server/index.js:109-113 returns
//
//	{ "error": { "code": "NOT_FOUND", "message": "Route not found" } }
//
// for any unmatched /api/* request.  chi's default writes plain text
// "404 page not found\n" with no JSON envelope, so frontend retry
// logic that branches on `error.code === 'NOT_FOUND'` mis-classifies
// these as parse failures.  Wire both helpers in main.go via
// r.NotFound() and r.MethodNotAllowed().

import (
	"net/http"

	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
)

// NotFound is the chi-compatible NotFoundHandler that returns the
// Express byte-exact 404 envelope.  Same shape on every path —
// frontend doesn't care whether the miss was a typo'd /api/animes vs
// a deleted resource; it gets the same code to branch on.
func NotFound(w http.ResponseWriter, r *http.Request) {
	httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, "Route not found"))
}

// MethodNotAllowed is the chi-compatible MethodNotAllowedHandler.
// Express body-parser would surface 405 for known paths with wrong
// method; chi's default writes plain "405 Method Not Allowed".  Emit
// the same code (NOT_FOUND) Express used at the catch-all so the
// client retry tree doesn't grow a 405-specific branch.  status 405
// is preserved for observability tooling (logs / nginx access metrics).
func MethodNotAllowed(w http.ResponseWriter, r *http.Request) {
	httpx.Fail(w, httpx.NewError(http.StatusMethodNotAllowed, httpx.CodeNotFound, "Route not found"))
}

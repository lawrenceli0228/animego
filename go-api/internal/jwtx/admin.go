package jwtx

// admin.go — RequireAdmin middleware.  Chains AFTER RequireAuth; reads
// the *AccessClaims out of the request context (set by RequireAuth) and
// gates anything where claims.Role is not "admin".
//
// The 403 envelope is byte-exact to server/middleware/adminAuth.js:
//
//	res.status(403).json({ error: { code: 'FORBIDDEN', message: '无权限' } })
//
// Chain order matters:  RequireAdmin assumes claims are already in
// context.  Mounting it without RequireAuth in front would mean every
// request gets a 401 NO_TOKEN, because RequireAdmin treats missing
// claims as the same failure mode (defense-in-depth — never assume the
// upstream middleware actually ran).

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
)

const (
	codeForbidden = "FORBIDDEN"
	msgForbidden  = "无权限"

	adminRole = "admin"
)

// Pre-marshaled 403 body, same approach as NO_TOKEN / INVALID_TOKEN.
// json.Marshal is deterministic for these fixed strings.
var forbiddenBody = mustMarshalEnvelope(codeForbidden, msgForbidden)

// RequireAdmin returns a chi/http middleware that gates handlers behind
// claims.Role == "admin".  Mount AFTER RequireAuth:
//
//	r.With(jwtx.RequireAuth(signer), jwtx.RequireAdmin()).
//	    Get("/api/admin/stats", statsHandler)
//
// Failure modes:
//   - No claims in context (RequireAuth wasn't mounted, or returned
//     early): 403 with the same envelope — caller bug, log it.
//   - Role nil or != "admin":  403 byte-exact 无权限.
func RequireAdmin() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			claims, ok := ClaimsFrom(r.Context())
			if !ok || claims == nil {
				// Upstream RequireAuth didn't run, or stripped the
				// claims somehow.  Bail with the same 403 envelope —
				// we deliberately do NOT distinguish "missing auth"
				// from "wrong role" to avoid leaking middleware order.
				slog.Warn("jwtx.RequireAdmin: missing claims in context",
					"path", r.URL.Path,
				)
				writeForbidden(w)
				return
			}
			if claims.Role == nil || *claims.Role != adminRole {
				writeForbidden(w)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// writeForbidden emits the canonical 403 body.  Content-Type + bytes
// match Express's adminAuth middleware exactly.
func writeForbidden(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusForbidden)
	if _, err := w.Write(forbiddenBody); err != nil {
		slog.Warn("jwtx: write 403 envelope", "err", err)
	}
}

// init compile-time assertion that the marshaled body matches the
// hand-crafted bytes we expect.  Catches accidental json package changes
// (e.g. a future Go release adding new whitespace) at process start
// rather than in production.
//
//nolint:gochecknoinits
func init() {
	expected := []byte(`{"error":{"code":"FORBIDDEN","message":"无权限"}}`)
	if !bytes.Equal(forbiddenBody, expected) {
		panic("jwtx: forbidden envelope bytes drifted — fix mustMarshalEnvelope")
	}
	// silence unused-import check when json isn't otherwise referenced
	_ = json.RawMessage(nil)
}

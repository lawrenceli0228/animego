package jwtx

// middleware.go — RequireAuth chi/http middleware.
//
// Dual-accept (P2.2 4A cutover): the access token can arrive via EITHER
//
//  1. Authorization: Bearer <access>   (legacy Express + new SSR API calls
//                                       made from server components that
//                                       can set the header explicitly)
//  2. Cookie: accessToken=<access>     (NEW path so Next.js SSR + browser
//                                       requests work without explicit
//                                       header plumbing)
//
// Header wins if both are present.  The `refreshToken` cookie is NOT
// touched here — it's consumed only by POST /api/auth/refresh.  Reusing
// the refresh cookie for middleware would mean re-validating a 7-day
// secret on every API call, which defeats the point of short-lived
// access tokens.
//
// Error responses use the canonical envelope (English message; the
// frontend i18n layer maps these to localized strings):
//   - No token at all → 401 { error: { code: NO_TOKEN, message: Authentication required } }
//   - Token present but invalid → 401 { error: { code: INVALID_TOKEN, message: Invalid token } }
//
// We deliberately collapse expired / malformed / wrong-signature into a
// single INVALID_TOKEN to avoid leaking the specific failure reason.

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
)

// AccessTokenCookieName is the cookie key the middleware reads when no
// Authorization header is present.  Exported so the auth controller can
// set the same name when issuing the cookie on login/refresh.
const AccessTokenCookieName = "accessToken"

// envelope helpers — exported codes / messages so tests + the auth
// controller can reference the same constants.  Kept verbatim to match
// server/middleware/auth.middleware.js error envelopes.
const (
	codeNoToken      = "NO_TOKEN"
	codeInvalidToken = "INVALID_TOKEN"

	msgNoToken      = "Authentication required"
	msgInvalidToken = "Invalid token"
)

// Pre-marshaled 401 bodies.  json.Marshal is deterministic for these
// fixed strings, and pre-marshaling lets the middleware skip
// per-request encoder setup.  Bytes match the writeJSON output from
// internal/httpx (no HTML escaping, no trailing newline).
var (
	noTokenBody      = mustMarshalEnvelope(codeNoToken, msgNoToken)
	invalidTokenBody = mustMarshalEnvelope(codeInvalidToken, msgInvalidToken)
)

func mustMarshalEnvelope(code, message string) []byte {
	type body struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	type envelope struct {
		Error body `json:"error"`
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(envelope{Error: body{Code: code, Message: message}}); err != nil {
		// Compile-time-stable inputs — this can't fail in practice.
		panic(err)
	}
	return bytes.TrimRight(buf.Bytes(), "\n")
}

// RequireAuth returns a chi/http middleware that gates handlers behind
// a valid access token.  Pull the verified claims out of the request
// context via ClaimsFrom inside the wrapped handler.
//
// Usage:
//
//	r.With(jwtx.RequireAuth(signer)).Get("/api/me", meHandler)
func RequireAuth(s *Signer) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token, ok := extractToken(r)
			if !ok {
				writeUnauthorized(w, noTokenBody)
				return
			}
			claims, err := s.VerifyAccess(token)
			if err != nil {
				writeUnauthorized(w, invalidTokenBody)
				return
			}
			ctx := withClaims(r.Context(), claims)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// extractToken pulls the access token from the request.  Header wins.
// Returns ("", false) when nothing usable is present so the caller can
// emit NO_TOKEN (vs an empty-string token that would later fail as
// INVALID_TOKEN).
func extractToken(r *http.Request) (string, bool) {
	// 1. Authorization: Bearer <token>
	if h := r.Header.Get("Authorization"); h != "" {
		if rest, found := strings.CutPrefix(h, "Bearer "); found {
			rest = strings.TrimSpace(rest)
			if rest != "" {
				return rest, true
			}
		}
		// Header present but not Bearer (e.g. Basic) — fall through
		// to the cookie path rather than 401-ing immediately.  This
		// keeps clients that mix auth schemes working.
	}

	// 2. Cookie: accessToken=<token>
	if c, err := r.Cookie(AccessTokenCookieName); err == nil && c.Value != "" {
		return c.Value, true
	}

	return "", false
}

// writeUnauthorized emits a 401 with the pre-marshaled envelope body.
// Content-Type matches internal/httpx exactly so the response is
// indistinguishable from a httpx.Fail call.
func writeUnauthorized(w http.ResponseWriter, body []byte) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusUnauthorized)
	if _, err := w.Write(body); err != nil {
		slog.Warn("jwtx: write 401 envelope", "err", err)
	}
}
